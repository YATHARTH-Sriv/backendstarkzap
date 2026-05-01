## Server Code For Zen Mobile 

This repo contains all the code login with privy username wallet creaion deploy wallet 

1. send
2. swap
3. prediction custom contract calling
4. Defi 
5. Balance and TXn History

How To Run This Whole Mobile App:


---

## Prerequisites

Ensure you have the following installed on your system:
* Node.js
* Expo

## API Keys Required

Create a .env file based on the variables below. Refer to .env.example for more details.

## Environment Variables Configuration

Create a `.env` file in the root directory and populate it with the following variables:

| Variable | Description | Example/Value |
| :--- | :--- | :--- |
| **RPC_URL** | Starknet RPC provider URL | 
| **STARKNET_CHAIN_ID** | Network identifier | 
| **DATABASE_URL** | Neon DB | 
| **PORT** | local server port | `8001` |
| **COUNTER_CONTRACT_ADDRESS** | Address of the Counter contract | `0x0614132...88066` |
| **PREDICTION_CONTRACT** | Address of the Prediction contract | `0x07b4c5a...5e6f77e` |
| **STRK_TOKEN** | Starknet Token contract address | `0x04718f5...7c938d` |
| **STAKING_FALLBACK_POOL** | Fallback staking pool address | `0x03588c9...4676` |
| **STAKING_ESTIMATED_APY** | Projected staking APY | `4.8` |
| **ONBOARDING_FUNDING_ENABLED** | Enable auto-funding for new users | `true` |
| **ONBOARDING_FUNDING_AMOUNT_STRK**| Amount of STRK to fund | `10` |
| **ONBOARDING_FUNDER_ADDRESS** | Wallet address providing funds | `0x...` |
| **ONBOARDING_FUNDER_PRIVATE_KEY**| Private key for the funder wallet | `0x...` |
| **PRIVY_APP_ID** | Privy Project ID | `your_privy_id` |
| **PRIVY_APP_SECRET** | Privy App Secret Key | `your_privy_secret` |
| **PRIVY_VERIFICATION_KEY** | Privy Verification Public Key | `your_privy_key` |
| **COINMARKET_API_KEY** | CoinMarketCap API Key | `your_api_key` |



---

## Installation and Setup

Follow these steps to test the application locally.

### 1. Clone the Repositories
Copy and run these commands in your terminal:

```bash
# Mobile Client Repository
git clone https://github.com/YATHARTH-Sriv/mobilestarkzap.git 

# Backend Repository
git clone https://github.com/YATHARTH-Sriv/backendstarkzap

```



### 2. Configure the Backend
Open the backendstarkzap folder in your IDE and run:

```Bash
npm install
npm run start
```
Verify that all environment variables are set before running.

### 3. Configure the Mobile Client
Open the mobilestarkzap folder in your IDE and perform the following:

Install Dependencies:

```Bash
npm install
Network Configuration:
```

Run the following command to get your local IP address:

```Bash
ipconfig getifaddr en0
Copy the value and set it in your environment variables:
EXPO_PUBLIC_BACKEND_URL=http://<value>:8000
```


Alchemy Setup:
Obtain an Alchemy RPC URL and ensure all other environment variables are configured.

Start the Client:

```Bash
npm run start
```

Testing on Mobile
Install the Expo Go app from the Play Store or App Store.

Scan the QR code displayed in your terminal from the mobilestarkzap workspace.
