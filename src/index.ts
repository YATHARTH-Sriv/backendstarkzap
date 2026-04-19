import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import http from "node:http";
import { createDbPool, createPrivyClient, createStarkZap } from "./config/clients.ts";
import { loadConfig } from "./config/env.ts";
import { createChatRepository } from "./db/chat-repo.ts";
import { initDatabase } from "./db/init.ts";
import { createRoomMarketRepository } from "./db/room-market-repo.ts";
import { createTxActivityRepository } from "./db/tx-activity-repo.ts";
import { createUserProfileRepository } from "./db/user-profile-repo.ts";
import { createWalletRepository } from "./db/wallet-repo.ts";
import { createRequirePrivyUser } from "./middleware/require-privy-user.ts";
import { createCounterRouter } from "./routes/counter-routes.ts";
import { createChatRouter } from "./routes/chat-routes.ts";
import { createMarketSourceRouter } from "./routes/market-source-routes.ts";
import { createMiscRouter } from "./routes/misc-routes.ts";
import { createPredictionRouter } from "./routes/prediction-routes.ts";
import { createProfileRouter } from "./routes/profile-routes.ts";
import { createPaymentsRouter } from "./routes/payments-routes.ts";
import { createRoomMarketRouter } from "./routes/room-market-routes.ts";
import { createWalletRouter } from "./routes/wallet-routes.ts";
import { createStarknetWalletService } from "./services/starknet-wallet.ts";
import { attachChatServer } from "./ws/chat-server.ts";
import { createDirectPaymentRepository } from "./db/direct-payment-repo.ts";

dotenv.config();

const config = loadConfig();
const app = express();

app.use(express.json());
app.use(cors());

const privy = createPrivyClient();
const sdk = createStarkZap(config);
const db = createDbPool(config);

const walletRepo = createWalletRepository(db);
const chatRepo = createChatRepository(db);
const roomMarketRepo = createRoomMarketRepository(db);
const txActivityRepo = createTxActivityRepository(db);
const userProfileRepo = createUserProfileRepository(db);
const directPaymentRepo = createDirectPaymentRepository(db);
const requirePrivyUser = createRequirePrivyUser(privy, walletRepo);

const walletService = createStarknetWalletService({
  privy,
  sdk,
  chainId: config.chainId,
  walletDeployFeeMode: config.walletDeployFeeMode,
});

app.use(createMiscRouter());
app.use(
  createChatRouter({
    chatRepo,
    requirePrivyUser,
    userProfileRepo,
  }),
);
app.use(createMarketSourceRouter());
app.use(
  createProfileRouter({
    requirePrivyUser,
    walletRepo,
    userProfileRepo,
    chatRepo,
    txActivityRepo,
  }),
);
app.use(
  createRoomMarketRouter({
    sdk,
    predictionContractAddress: config.predictionContractAddress,
    requirePrivyUser,
    walletRepo,
    userProfileRepo,
    chatRepo,
    roomMarketRepo,
  }),
);
app.use(
  createWalletRouter({
    privy,
    walletRepo,
    requirePrivyUser,
    walletService,
    txActivityRepo,
  }),
);
app.use(
  createCounterRouter({
    sdk,
    counterContractAddress: config.counterContractAddress,
    requirePrivyUser,
    walletRepo,
    walletService,
    txActivityRepo,
  }),
);
app.use(
  createPredictionRouter({
    sdk,
    predictionContractAddress: config.predictionContractAddress,
    strkTokenContractAddress: config.strkTokenContractAddress,
    requirePrivyUser,
    walletRepo,
    walletService,
    txActivityRepo,
  }),
);
app.use(
  createPaymentsRouter({
    chainId: config.chainId,
    requirePrivyUser,
    walletRepo,
    userProfileRepo,
    directPaymentRepo,
    walletService,
    txActivityRepo,
  }),
);

const server = http.createServer(app);
attachChatServer(server, {
  chatRepo,
  userProfileRepo,
  privy,
});

async function main() {
  await initDatabase(db);

  server.listen(config.port, () => {
    console.log(`SERVER RUNNING ON PORT: ${config.port}`);
  });
}

main().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
