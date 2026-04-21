# StarkBet — Express Backend

The backend server for **StarkBet**, built with **ExpressJs** and **TypeScript**. This server handles authentication, wallet management, payments, prediction markets, real-time chat, and all on-chain interactions with Starknet via [**StarkZap**](https://www.starkzap.com/).

> Every blockchain transaction in the app flows through this server. The mobile client never touches private keys — it sends authenticated API requests, and this server uses StarkZap to sign and execute transactions on Starknet.

---

## Architecture Overview

```
 Express Server (:8001)

    Privy Auth         StarkZap          PostgreSQL (pg)
    Middleware         SDK
                                         • app_users
    Verifies          • Wallet           • user_wallets
    access              connection        • chat_rooms
    tokens            • TX execute       • chat_messages
                      • Contract         • direct_payments
                       reads        • prediction markets

   WebSocket Server (ws)
  Real-time chat: rooms, DMs, typing indicators

```

---

## How StarkZap Is Used

StarkZap (`starkzap` npm package) is the core SDK for all Starknet interactions. Here's how it works in this server:

### 1. SDK Initialization (`src/config/clients.ts`)

```typescript
import { StarkZap } from "starkzap";

const sdk = new StarkZap({
  rpcUrl: config.rpcUrl, // Starknet RPC endpoint
  chainId: config.chainId, // ChainId.SEPOLIA or ChainId.MAINNET
});
```

### 2. Connecting User Wallets (`src/services/starknet-wallet.ts`)

Each user gets a Privy-managed embedded wallet. StarkZap bridges the Privy signer with Starknet's account abstraction:

```typescript
import { PrivySigner, ArgentXV050Preset } from "starkzap";

const signer = new PrivySigner({
  walletId: wallet.id,
  publicKey: wallet.publicKey,
  rawSign: async (walletId, hash) => {
    const result = await privy
      .wallets()
      .rawSign(walletId, { params: { hash } });
    return result.signature;
  },
});

const userWallet = await sdk.connectWallet({
  account: {
    signer,
    accountClass: ArgentXV050Preset, // ArgentX v0.5.0 account
  },
});
```

### 3. Deploying Wallets

```typescript
await userWallet.ensureReady({ deploy: "if_needed" });
```

This deploys the account contract on-chain if it hasn't been deployed yet.

### 4. Executing Transactions

All transactions go through a helper with automatic out-of-gas retry:

```typescript
// Single call
const tx = await userWallet.execute({
  contractAddress: STRK.address,
  entrypoint: "transfer",
  calldata: [recipientAddress, amountLow, amountHigh],
});

// Multicall (e.g., approve + place_bet)
const tx = await userWallet.execute([approveCall, betCall]);
```

If the first attempt fails with an out-of-gas error, the service automatically re-estimates fees with boosted resource bounds and retries.

### 5. Reading On-Chain State

```typescript
// Read prediction market data
const result = await sdk.callContract({
  contractAddress: predictionContractAddress,
  entrypoint: "get_market_count",
  calldata: [],
});
```

### 6. Token Utilities

```typescript
import { Amount, getPresets, fromAddress } from "starkzap";

const presets = getPresets(chainId);
const STRK = presets.STRK; // Token definition
const amount = Amount.parse("5.0", STRK); // Parse human-readable amount
const balance = await userWallet.balanceOf(STRK); // Check balance
const normalized = fromAddress(walletAddress); // Normalize address to felt
```

---

## API Endpoints

All endpoints (except health check and market previews) require a `Authorization: Bearer <privy_access_token>` header.

### Wallet Management

| Method | Endpoint                       | Description                                                     |
| ------ | ------------------------------ | --------------------------------------------------------------- |
| `POST` | `/api/wallet/starknet`         | Create or retrieve a Starknet wallet for the authenticated user |
| `GET`  | `/api/wallet/onboarding-state` | Get wallet + funding status for the onboarding flow             |
| `POST` | `/api/wallet/fund-onboarding`  | Auto-fund the user's wallet with STRK (Sepolia only)            |
| `POST` | `/api/wallet/deploy`           | Deploy the user's account contract on-chain                     |
| `POST` | `/api/wallet/sign`             | Sign a raw hash with the user's wallet                          |

### Payments

| Method | Endpoint                          | Description                               |
| ------ | --------------------------------- | ----------------------------------------- |
| `POST` | `/api/payments/send`              | Send STRK to a username or wallet address |
| `GET`  | `/api/payments/search-users?q=`   | Search users by username for payment      |
| `GET`  | `/api/payments/recent-contacts`   | List recent payment contacts              |
| `GET`  | `/api/payments/history/:username` | Get bilateral payment history with a user |

### Profile

| Method | Endpoint                           | Description                                                    |
| ------ | ---------------------------------- | -------------------------------------------------------------- |
| `GET`  | `/api/profile/me`                  | Get current user's profile + wallet info                       |
| `POST` | `/api/profile/username`            | Set or update username (3-20 chars, alphanumeric + underscore) |
| `POST` | `/api/profile/onboarding/complete` | Mark onboarding as complete                                    |
| `GET`  | `/api/profile/transactions`        | List recent transaction activity                               |

### Prediction Markets

| Method | Endpoint                   | Description                                         |
| ------ | -------------------------- | --------------------------------------------------- |
| `GET`  | `/api/market-count`        | Get total number of on-chain markets                |
| `GET`  | `/api/prediction/balances` | Get user's STRK balance + contract treasury balance |
| `POST` | `/create-market`           | Create a new binary prediction market on-chain      |
| `POST` | `/place-bet`               | Place a bet (approve + bet multicall)               |
| `POST` | `/resolve-market`          | Resolve a market (creator only)                     |
| `POST` | `/claim-winnings`          | Claim winnings from a resolved market               |

### Chat Rooms

| Method | Endpoint                                     | Description                             |
| ------ | -------------------------------------------- | --------------------------------------- |
| `GET`  | `/api/chat/rooms`                            | List visible rooms for the user         |
| `POST` | `/api/chat/rooms`                            | Create a new chat room                  |
| `GET`  | `/api/chat/rooms/:room/messages`             | Load room message history               |
| `GET`  | `/api/chat/rooms/:room/members`              | List active room members                |
| `GET`  | `/api/chat/rooms/:room/requests`             | List pending join requests (admin only) |
| `POST` | `/api/chat/rooms/:room/invite`               | Invite a user by username (admin only)  |
| `POST` | `/api/chat/rooms/:room/requests/:id/approve` | Approve a join request                  |
| `POST` | `/api/chat/rooms/:room/requests/:id/reject`  | Reject a join request                   |
| `GET`  | `/api/chat/dm/history?target=`               | Load DM history between two users       |

### Room Markets

| Method | Endpoint                                        | Description                                |
| ------ | ----------------------------------------------- | ------------------------------------------ |
| `POST` | `/api/chat/rooms/:room/external-markets`        | Link a Polymarket/Kalshi market to a room  |
| `GET`  | `/api/chat/rooms/:room/external-markets`        | List external market links in a room       |
| `POST` | `/api/chat/rooms/:room/markets/attach`          | Attach an on-chain market to a room        |
| `GET`  | `/api/chat/rooms/:room/markets`                 | List on-chain markets in a room            |
| `GET`  | `/api/chat/rooms/:room/markets/:id/details`     | Get full on-chain market details           |
| `GET`  | `/api/chat/rooms/:room/markets/:id/can-resolve` | Check if current user can resolve a market |

### Market Sources (Public)

| Method | Endpoint                        | Description                                     |
| ------ | ------------------------------- | ----------------------------------------------- |
| `GET`  | `/api/markets/preview?url=`     | Preview any market by URL (Polymarket / Kalshi) |
| `GET`  | `/api/markets/polymarket?slug=` | Preview a Polymarket market by slug             |
| `GET`  | `/api/markets/kalshi?ticker=`   | Preview a Kalshi market by ticker               |

### Misc

| Method | Endpoint      | Description  |
| ------ | ------------- | ------------ |
| `GET`  | `/api/health` | Health check |

---

## WebSocket Events

Connect to `ws://localhost:8001` with a Privy access token (as `?token=` query param or `Authorization` header).

### Client → Server

| Event             | Payload                                 | Description                        |
| ----------------- | --------------------------------------- | ---------------------------------- |
| `set_username`    | `{}`                                    | Sync username from profile         |
| `join_room`       | `{ room: string }`                      | Join a chat room                   |
| `leave_room`      | `{}`                                    | Leave the current room             |
| `chat_message`    | `{ content: string }`                   | Send a message to the current room |
| `private_message` | `{ targetId: string, content: string }` | Send a DM                          |
| `typing_start`    | `{}`                                    | Broadcast typing indicator         |
| `typing_stop`     | `{}`                                    | Stop typing indicator              |

### Server → Client

| Event                | Description                                  |
| -------------------- | -------------------------------------------- |
| `connection`         | Connection established (includes `clientId`) |
| `username_set`       | Username confirmed                           |
| `room_joined`        | Joined a room                                |
| `room_left`          | Left a room                                  |
| `room_users`         | Updated list of users in the room            |
| `room_access_update` | Join request status (pending / denied)       |
| `message_received`   | New message in the room                      |
| `message_history`    | Recent room messages on join                 |
| `user_joined`        | A user joined the room                       |
| `user_left`          | A user left the room                         |
| `private_message`    | Incoming DM                                  |
| `typing_indicator`   | Someone is typing                            |
| `error`              | Error message                                |

---

## Database Schema

The server auto-creates all tables on startup via `src/db/init.ts`. PostgreSQL tables include:

| Table                       | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `app_users`                 | User accounts (Privy user ID, username, onboarding state)     |
| `user_wallets`              | Starknet wallets linked to users                              |
| `user_onboarding_funding`   | Tracks auto-funding status for new wallets                    |
| `user_transaction_activity` | Log of all wallet actions (creates, deploys, transfers, bets) |
| `user_direct_payments`      | Payment records between users                                 |
| `chat_profiles`             | Chat system user profiles                                     |
| `chat_rooms`                | Room definitions (name, visibility, join policy)              |
| `chat_room_memberships`     | Room membership with roles (owner, admin, member)             |
| `chat_room_members`         | Legacy room members table                                     |
| `chat_messages`             | Room message history                                          |
| `chat_private_messages`     | DM history                                                    |
| `room_external_markets`     | Linked Polymarket / Kalshi markets in rooms                   |
| `room_contract_markets`     | On-chain prediction markets attached to rooms                 |

---

## Prerequisites

- **Node.js** ≥ 18
- **npm** (comes with Node)
- **PostgreSQL** — A running PostgreSQL instance (NeonDB)
- **Starknet RPC URL** — From providers like [Alchemy](https://www.alchemy.com/starknet)
- **Privy account** — App ID, App Secret, and Verification Key from [privy.io](https://www.privy.io/)
- **(Optional) Funded Starknet wallet** — For auto-funding new users on Sepolia testnet

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/YATHARTH-Sriv/mobilestarkzap.git
cd mobilestarkzap/expresscode
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values

### 4. Set up PostgreSQL

Make sure your PostgreSQL database is running and accessible. The server will auto-create all tables on startup.

### 5. Start the server

```bash
npm run dev
```

The server will start on `http://localhost:8001` (default).

---

## Environment Variables

Create a `.env` file in the `expresscode/` directory:

```env
# ─── Starknet RPC ────────────────────────────────────────────
# Your Starknet RPC endpoint (Sepolia or Mainnet)
# Get one from Alchemy, Infura, or Blast API
RPC_URL=https://starknet-sepolia.g.alchemy.com/v2/YOUR_API_KEY

# ─── Smart Contract Addresses ────────────────────────────────
# Counter contract address (demo contract for testing)
COUNTER_CONTRACT_ADDRESS=0x0614132d361d532ed97b9baa1c2374ad260cafe9af16dda63e7f967f72888066

# Prediction market contract address (Cairo contract for binary markets)
PREDICTION_CONTRACT=0x07b4c5ae684e0c4f5cb7b73f2f6714a78a55706cee6109773e37cd7275e6f77e

# STRK token contract address on Sepolia
STRK_TOKEN=0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d

# ─── Chain Configuration ─────────────────────────────────────
# Which Starknet network to use: SN_SEPOLIA or SN_MAIN
STARKNET_CHAIN_ID=SN_SEPOLIA

# ─── Onboarding Funding (Sepolia only) ───────────────────────
# Auto-fund new wallets with STRK for gas and initial usage
ONBOARDING_FUNDING_ENABLED=true

# Amount of STRK to send to each new wallet
ONBOARDING_FUNDING_AMOUNT_STRK=10

# The address of the funded wallet that sends STRK to new users
ONBOARDING_FUNDER_ADDRESS=0xYOUR_FUNDER_WALLET_ADDRESS

# Private key of the funder wallet (keep this secret!)
ONBOARDING_FUNDER_PRIVATE_KEY=0xYOUR_FUNDER_PRIVATE_KEY

# ─── Database ────────────────────────────────────────────────
# PostgreSQL connection string
# Examples:
#   Local:   postgresql://postgres:password@localhost:5432/starkbet
#   Cloud:   postgresql://user:pass@host:5432/db?sslmode=require
DATABASE_URL=postgresql://postgres:password@localhost:5432/starkbet

# ─── Privy Authentication ────────────────────────────────────
# From your Privy dashboard (https://dashboard.privy.io)
PRIVY_APP_ID=your_privy_app_id
PRIVY_APP_SECRET=your_privy_app_secret
PRIVY_VERIFICATION_KEY=your_privy_verification_key
```

---

## Running the Server

### Development (with hot reload)

```bash
npm run dev
```

This uses `tsx watch` to automatically restart on file changes.

### Production

```bash
npm start
```

### Type checking

```bash
npm run typecheck
```

---

## Project Structure

```
expresscode/
├── src/
│   ├── index.ts                 # Server entry — app setup, route mounting, startup
│   ├── types.ts                 # Shared types (WebSocket messages, chat types)
│   │
│   ├── config/
│   │   ├── env.ts               # Environment variable parsing + validation
│   │   └── clients.ts           # Privy, StarkZap, and PostgreSQL client factories
│   │
│   ├── middleware/
│   │   └── require-privy-user.ts  # Auth middleware — verifies Privy bearer tokens
│   │
│   ├── routes/
│   │   ├── wallet-routes.ts     # Wallet creation, funding, deployment, signing
│   │   ├── payments-routes.ts   # Send STRK, search users, payment history
│   │   ├── prediction-routes.ts # Create/resolve markets, place bets, claim winnings
│   │   ├── profile-routes.ts    # User profile, username, onboarding, tx history
│   │   ├── chat-routes.ts       # Chat rooms, messages, memberships, DMs
│   │   ├── room-market-routes.ts # Link markets to rooms, read on-chain state
│   │   ├── market-source-routes.ts # Polymarket/Kalshi market previews
│   │   ├── counter-routes.ts    # Counter contract demo (increment/read)
│   │   └── misc-routes.ts       # Health check
│   │
│   ├── services/
│   │   ├── starknet-wallet.ts   # StarkZap wallet service (connect, deploy, execute)
│   │   ├── market-source.ts     # External market data fetcher (Polymarket, Kalshi)
│   │   ├── error-utils.ts       # Error message extraction helpers
│   │   ├── felt-utils.ts        # Starknet felt252 encoding/parsing
│   │   ├── u256-utils.ts        # U256 calldata encoding + ERC-20 balance reader
│   │   └── market-source.test.ts # Market source unit tests
│   │
│   ├── db/
│   │   ├── init.ts              # Database schema + auto-migration (CREATE TABLE)
│   │   ├── wallet-repo.ts       # Wallet CRUD operations
│   │   ├── chat-repo.ts         # Chat rooms, messages, memberships
│   │   ├── user-profile-repo.ts # User profiles + username management
│   │   ├── direct-payment-repo.ts # Payment records + contact search
│   │   ├── room-market-repo.ts  # Room ↔ market link persistence
│   │   ├── tx-activity-repo.ts  # Transaction activity log
│   │   └── onboarding-funding-repo.ts # Onboarding funding state tracking
│   │
│   └── ws/
│       └── chat-server.ts       # WebSocket server — real-time chat engine
│
├── package.json                 # Dependencies & scripts
├── .env.example                 # Environment variable template
└── Readme.md                    # ← You are here
```

---
