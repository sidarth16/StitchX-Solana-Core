import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  TOKEN_PROGRAM_ID,
  expandHome,
  getProgram,
  lockComposition,
  loadKeypair,
  loadKeypairFromSecretKey,
  logStep,
  sendTransactionWithLogs,
  userStatePda,
} from "./stitchx-shared";

loadDotenv(path.resolve(".env"));

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath = expandHome(
    process.env.WALLET_PATH ?? process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json"
  );
  const walletSecretKey =
    process.env.PRIVATE_KEY ??
    process.env.WALLET_SECRET_KEY ??
    "";
  const sceneSeed = Number(process.env.SCENE_KEY_SEED ?? 7);
  const limit = Math.max(1, Number(process.env.LIMIT ?? 2));
  const explicitMints = parseCsv(process.env.ASSET_MINTS);

  const walletKeypair = walletSecretKey
    ? loadKeypairFromSecretKey(walletSecretKey)
    : loadKeypair(walletPath);
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet = {
    publicKey: walletKeypair.publicKey,
    payer: walletKeypair,
    signTransaction: async (tx: anchor.web3.Transaction) => {
      tx.partialSign(walletKeypair);
      return tx;
    },
    signAllTransactions: async (txs: anchor.web3.Transaction[]) => {
      txs.forEach((tx) => tx.partialSign(walletKeypair));
      return txs;
    },
  };
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = getProgram(provider);
  const owner = walletKeypair.publicKey;
  const userState = userStatePda(owner);

  logStep("Starting StitchX CLI lock flow", {
    rpcUrl,
    wallet: owner.toBase58(),
    walletSource: walletSecretKey
      ? (process.env.PRIVATE_KEY ? "PRIVATE_KEY" : "WALLET_SECRET_KEY")
      : walletPath,
    sceneSeed,
  });

  await ensureUserState(program, provider, owner, userState);

  const ownedTokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: TOKEN_PROGRAM_ID,
  });

  const ownedAssets = ownedTokenAccounts.value
    .map(({ pubkey, account }) => ({
      tokenAccount: pubkey,
      info: account.data.parsed?.info,
    }))
    .filter(({ info }) => Boolean(info?.mint))
    .filter(({ info }) => {
      const amount = info.tokenAmount || {};
      return amount.amount === "1" && amount.decimals === 0;
    })
    .map(({ tokenAccount, info }) => ({
      mint: new PublicKey(String(info.mint)),
      tokenAccount,
    }));

  if (!ownedAssets.length) {
    throw new Error("No owned NFT-like token accounts found for this wallet.");
  }

  const selectedAssets = explicitMints.length
    ? explicitMints.map((mint) => {
        const match = ownedAssets.find((asset) => asset.mint.toBase58() === mint);
        if (!match) {
          throw new Error(`Wallet does not own mint ${mint}.`);
        }
        return match;
      })
    : ownedAssets.slice(0, limit);

  const assetMints = selectedAssets.map((asset) => asset.mint);
  const tokenAccounts = selectedAssets.map((asset) => asset.tokenAccount);
  const currentState = await program.account.userState.fetch(userState);
  const compId = Number(currentState.compositionCount.toString());

  logStep("Selected assets", {
    compId,
    assetMints: assetMints.map((mint) => mint.toBase58()).join(", "),
  });

  const result = await lockComposition(
    program,
    owner,
    userState,
    assetMints,
    tokenAccounts,
    compId,
    sceneSeed
  );

  logStep("Lock succeeded", {
    composition: result.composition.toBase58(),
    lockRecords: result.lockRecords.map((pk) => pk.toBase58()).join(", "),
  });
}

function loadDotenv(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (process.env[key] !== undefined) {
      continue;
    }
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function ensureUserState(
  program: anchor.Program,
  provider: anchor.AnchorProvider,
  owner: PublicKey,
  userState: PublicKey
) {
  const existing = await provider.connection.getAccountInfo(userState);
  if (existing) {
    return;
  }

  const tx = await program.methods
    .initializeUser()
    .accounts({
      authority: owner,
      userState,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .transaction();

  await sendTransactionWithLogs(provider, tx, [], "initialize_user");
}

function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
