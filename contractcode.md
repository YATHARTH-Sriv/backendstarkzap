use starknet::ContractAddress;

/// ERC20 interface for STRK token interactions.
#[starknet::interface]
pub trait IERC20<TContractState> {
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState,
        sender: ContractAddress,
        recipient: ContractAddress,
        amount: u256,
    ) -> bool;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
}

/// Prediction Market interface.
#[starknet::interface]
pub trait IPredictionMarket<TContractState> {
    /// Create a new binary prediction market.
    fn create_market(ref self: TContractState, question: felt252, deadline: u64);
    /// Place a bet on a market. `outcome` = true for Yes, false for No.
    fn place_bet(ref self: TContractState, market_id: u32, outcome: bool, amount: u256);
    /// Owner resolves a market after its deadline.
    fn resolve_market(ref self: TContractState, market_id: u32, winning_outcome: bool);
    /// Winner claims their proportional payout.
    fn claim_winnings(ref self: TContractState, market_id: u32);
    /// Get the details of a market.
    fn get_market_count(self: @TContractState) -> u32;
    /// Get individual market fields.
    fn get_market_question(self: @TContractState, market_id: u32) -> felt252;
    fn get_market_creator(self: @TContractState, market_id: u32) -> ContractAddress;
    fn get_market_deadline(self: @TContractState, market_id: u32) -> u64;
    fn get_market_yes_pool(self: @TContractState, market_id: u32) -> u256;
    fn get_market_no_pool(self: @TContractState, market_id: u32) -> u256;
    fn get_market_resolved(self: @TContractState, market_id: u32) -> bool;
    fn get_market_winning_outcome(self: @TContractState, market_id: u32) -> bool;
    /// Get a user's bet on a market.
    fn get_user_bet_amount(
        self: @TContractState, market_id: u32, user: ContractAddress,
    ) -> u256;
    fn get_user_bet_outcome(
        self: @TContractState, market_id: u32, user: ContractAddress,
    ) -> bool;
    fn get_user_bet_claimed(
        self: @TContractState, market_id: u32, user: ContractAddress,
    ) -> bool;
}

#[starknet::contract]
mod PredictionMarket {
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use starknet::storage::{
        Map, StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry,
    };
    use super::{IERC20Dispatcher, IERC20DispatcherTrait};

    // ───────────────────────────── Storage ─────────────────────────────

    #[storage]
    struct Storage {
        owner: ContractAddress,
        token: ContractAddress,
        market_count: u32,
        // Market fields stored individually to avoid Store derive issues
        market_question: Map<u32, felt252>,
        market_creator: Map<u32, ContractAddress>,
        market_deadline: Map<u32, u64>,
        market_yes_pool: Map<u32, u256>,
        market_no_pool: Map<u32, u256>,
        market_resolved: Map<u32, bool>,
        market_winning_outcome: Map<u32, bool>,
        // Bets: market_id -> user -> field
        bet_amount: Map<u32, Map<ContractAddress, u256>>,
        bet_outcome: Map<u32, Map<ContractAddress, bool>>,
        bet_claimed: Map<u32, Map<ContractAddress, bool>>,
        bet_exists: Map<u32, Map<ContractAddress, bool>>,
    }

    // ───────────────────────────── Events ──────────────────────────────

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        MarketCreated: MarketCreated,
        BetPlaced: BetPlaced,
        MarketResolved: MarketResolved,
        WinningsClaimed: WinningsClaimed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketCreated {
        #[key]
        pub market_id: u32,
        pub question: felt252,
        pub creator: ContractAddress,
        pub deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BetPlaced {
        #[key]
        pub market_id: u32,
        #[key]
        pub user: ContractAddress,
        pub outcome: bool,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketResolved {
        #[key]
        pub market_id: u32,
        pub winning_outcome: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct WinningsClaimed {
        #[key]
        pub market_id: u32,
        #[key]
        pub user: ContractAddress,
        pub amount: u256,
    }

    // ──────────────────────────── Constructor ──────────────────────────

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, token: ContractAddress) {
        self.owner.write(owner);
        self.token.write(token);
        self.market_count.write(0);
    }

    // ──────────────────────── Implementation ──────────────────────────

    #[abi(embed_v0)]
    impl PredictionMarketImpl of super::IPredictionMarket<ContractState> {
        // ─── Create Market ───
        fn create_market(ref self: ContractState, question: felt252, deadline: u64) {
            let caller = get_caller_address();
            assert(deadline > get_block_timestamp(), 'Deadline must be in the future');

            let market_id = self.market_count.read();

            self.market_question.entry(market_id).write(question);
            self.market_creator.entry(market_id).write(caller);
            self.market_deadline.entry(market_id).write(deadline);
            self.market_yes_pool.entry(market_id).write(0);
            self.market_no_pool.entry(market_id).write(0);
            self.market_resolved.entry(market_id).write(false);
            self.market_winning_outcome.entry(market_id).write(false);

            self.market_count.write(market_id + 1);

            self.emit(MarketCreated { market_id, question, creator: caller, deadline });
        }

        // ─── Place Bet ───
        fn place_bet(ref self: ContractState, market_id: u32, outcome: bool, amount: u256) {
            assert(market_id < self.market_count.read(), 'Market does not exist');
            assert(!self.market_resolved.entry(market_id).read(), 'Market already resolved');
            assert(
                get_block_timestamp() < self.market_deadline.entry(market_id).read(),
                'Market deadline passed',
            );
            assert(amount > 0, 'Amount must be > 0');

            let caller = get_caller_address();
            assert(!self.bet_exists.entry(market_id).entry(caller).read(), 'Already bet on this market');

            // Transfer tokens from user to contract
            let token = IERC20Dispatcher {
                contract_address: self.token.read(),
            };
            let contract_address = starknet::get_contract_address();
            let success = token.transfer_from(caller, contract_address, amount);
            assert(success, 'Token transfer failed');

            // Record the bet
            self.bet_amount.entry(market_id).entry(caller).write(amount);
            self.bet_outcome.entry(market_id).entry(caller).write(outcome);
            self.bet_claimed.entry(market_id).entry(caller).write(false);
            self.bet_exists.entry(market_id).entry(caller).write(true);

            // Update pool
            if outcome {
                let current = self.market_yes_pool.entry(market_id).read();
                self.market_yes_pool.entry(market_id).write(current + amount);
            } else {
                let current = self.market_no_pool.entry(market_id).read();
                self.market_no_pool.entry(market_id).write(current + amount);
            }

            self.emit(BetPlaced { market_id, user: caller, outcome, amount });
        }

        // ─── Resolve Market ───
        fn resolve_market(ref self: ContractState, market_id: u32, winning_outcome: bool) {
            let caller = get_caller_address();
            assert(market_id < self.market_count.read(), 'Market does not exist');
            assert(
                caller == self.market_creator.entry(market_id).read(), 'Only creator can resolve',
            );
            assert(
                get_block_timestamp() >= self.market_deadline.entry(market_id).read(),
                'Market deadline not reached',
            );
            assert(!self.market_resolved.entry(market_id).read(), 'Already resolved');

            self.market_resolved.entry(market_id).write(true);
            self.market_winning_outcome.entry(market_id).write(winning_outcome);

            self.emit(MarketResolved { market_id, winning_outcome });
        }

        // ─── Claim Winnings ───
        fn claim_winnings(ref self: ContractState, market_id: u32) {
            assert(market_id < self.market_count.read(), 'Market does not exist');
            assert(self.market_resolved.entry(market_id).read(), 'Market not resolved yet');

            let caller = get_caller_address();
            assert(self.bet_exists.entry(market_id).entry(caller).read(), 'No bet found');
            assert(
                !self.bet_claimed.entry(market_id).entry(caller).read(), 'Already claimed',
            );

            let user_outcome = self.bet_outcome.entry(market_id).entry(caller).read();
            let winning_outcome = self.market_winning_outcome.entry(market_id).read();
            assert(user_outcome == winning_outcome, 'You did not win');

            let user_amount = self.bet_amount.entry(market_id).entry(caller).read();
            let yes_pool = self.market_yes_pool.entry(market_id).read();
            let no_pool = self.market_no_pool.entry(market_id).read();
            let total_pool = yes_pool + no_pool;

            let winning_pool = if winning_outcome {
                yes_pool
            } else {
                no_pool
            };

            assert(winning_pool > 0, 'Winning pool is empty');

            // Payout = (user_amount / winning_pool) * total_pool
            let payout = (user_amount * total_pool) / winning_pool;

            self.bet_claimed.entry(market_id).entry(caller).write(true);

            // Transfer payout to user
            let token = IERC20Dispatcher {
                contract_address: self.token.read(),
            };
            let success = token.transfer(caller, payout);
            assert(success, 'Payout transfer failed');

            self.emit(WinningsClaimed { market_id, user: caller, amount: payout });
        }

        // ─── View Functions ───

        fn get_market_count(self: @ContractState) -> u32 {
            self.market_count.read()
        }

        fn get_market_question(self: @ContractState, market_id: u32) -> felt252 {
            self.market_question.entry(market_id).read()
        }

        fn get_market_creator(self: @ContractState, market_id: u32) -> ContractAddress {
            self.market_creator.entry(market_id).read()
        }

        fn get_market_deadline(self: @ContractState, market_id: u32) -> u64 {
            self.market_deadline.entry(market_id).read()
        }

        fn get_market_yes_pool(self: @ContractState, market_id: u32) -> u256 {
            self.market_yes_pool.entry(market_id).read()
        }

        fn get_market_no_pool(self: @ContractState, market_id: u32) -> u256 {
            self.market_no_pool.entry(market_id).read()
        }

        fn get_market_resolved(self: @ContractState, market_id: u32) -> bool {
            self.market_resolved.entry(market_id).read()
        }

        fn get_market_winning_outcome(self: @ContractState, market_id: u32) -> bool {
            self.market_winning_outcome.entry(market_id).read()
        }

        fn get_user_bet_amount(
            self: @ContractState, market_id: u32, user: ContractAddress,
        ) -> u256 {
            self.bet_amount.entry(market_id).entry(user).read()
        }

        fn get_user_bet_outcome(
            self: @ContractState, market_id: u32, user: ContractAddress,
        ) -> bool {
            self.bet_outcome.entry(market_id).entry(user).read()
        }

        fn get_user_bet_claimed(
            self: @ContractState, market_id: u32, user: ContractAddress,
        ) -> bool {
            self.bet_claimed.entry(market_id).entry(user).read()
        }
    }
}
