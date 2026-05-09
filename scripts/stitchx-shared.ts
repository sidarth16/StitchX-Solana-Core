import * as fs from "node:fs";
import * as path from "node:path";

import bs58 from "bs58";

if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const anchor: typeof import("@anchor-lang/core") = require("@anchor-lang/core");

const idl = require("../target/idl/stitchx_sid.json");

export const PROGRAM_ID = new anchor.web3.PublicKey(idl.address);
export const TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export const MINT_LEN = 82;
export const TOKEN_ACCOUNT_LEN = 165;

export function getProvider() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  return provider;
}

export function getProgram(provider = getProvider()) {
  // This Anchor client expects the provider as the second argument and reads the
  // program id from `idl.address`, so we do not pass `PROGRAM_ID` here.
  return new anchor.Program(idl, provider);
}

export function userStatePda(owner: anchor.web3.PublicKey) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user-state"), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function compositionPda(owner: anchor.web3.PublicKey, compId: number) {
  const compIdBuf = Buffer.alloc(8);
  compIdBuf.writeBigUInt64LE(BigInt(compId));
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("composition"), owner.toBuffer(), compIdBuf],
    PROGRAM_ID,
  )[0];
}

export function lockRecordPda(assetMint: anchor.web3.PublicKey) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("lock"), assetMint.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function sceneKey(seed: number) {
  return Array.from({ length: 32 }, () => seed);
}

export function shortKey(pubkey: anchor.web3.PublicKey) {
  const base58 = pubkey.toBase58();
  return `${base58.slice(0, 4)}…${base58.slice(-4)}`;
}

export function expandHome(input: string) {
  if (!input.startsWith("~")) {
    return input;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    return input;
  }

  return path.join(home, input.slice(1));
}

export function loadKeypair(walletPath: string) {
  const raw = fs.readFileSync(walletPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(raw) as number[]);
  return anchor.web3.Keypair.fromSecretKey(secretKey);
}

export function loadKeypairFromSecretKey(secretKeyValue: string) {
  const trimmed = secretKeyValue.trim();
  if (!trimmed) {
    throw new Error("Wallet secret key is empty.");
  }

  if (trimmed.startsWith("[")) {
    const secretKey = Uint8Array.from(JSON.parse(trimmed) as number[]);
    return anchor.web3.Keypair.fromSecretKey(secretKey);
  }

  const secretKey = bs58.decode(trimmed);
  return anchor.web3.Keypair.fromSecretKey(secretKey);
}

export function logStep(title: string, details?: Record<string, string | number | boolean>) {
  const header = `\n=== ${title} ===`;
  console.log(header);
  if (!details) {
    return;
  }
  for (const [key, value] of Object.entries(details)) {
    console.log(`  ${key}: ${value}`);
  }
}

export async function ensureWalletFunding(
  provider: anchor.AnchorProvider,
  minimumLamports = 2 * anchor.web3.LAMPORTS_PER_SOL,
) {
  const current = await provider.connection.getBalance(provider.wallet.publicKey);
  if (current >= minimumLamports) {
    return;
  }

  const signature = await provider.connection.requestAirdrop(
    provider.wallet.publicKey,
    minimumLamports - current,
  );
  await provider.connection.confirmTransaction(signature, "confirmed");
}

export async function createSampleAsset(
  provider: anchor.AnchorProvider,
  owner: anchor.web3.PublicKey,
) {
  logStep("Minting sample SPL asset", { owner: shortKey(owner) });

  const mint = anchor.web3.Keypair.generate();
  const tokenAccount = anchor.web3.Keypair.generate();
  const rentMint = await provider.connection.getMinimumBalanceForRentExemption(MINT_LEN);
  const rentToken = await provider.connection.getMinimumBalanceForRentExemption(
    TOKEN_ACCOUNT_LEN,
  );

  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: rentMint,
      space: MINT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
    initializeMint2Ix(mint.publicKey, owner),
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: tokenAccount.publicKey,
      lamports: rentToken,
      space: TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
    initializeAccount3Ix(tokenAccount.publicKey, mint.publicKey, owner),
    mintToIx(mint.publicKey, tokenAccount.publicKey, owner, 1n),
  );

  await sendTransactionWithLogs(provider, tx, [mint, tokenAccount], "create_sample_asset");

  logStep("Sample asset ready", {
    mint: shortKey(mint.publicKey),
    tokenAccount: shortKey(tokenAccount.publicKey),
  });

  return {
    mint: mint.publicKey,
    tokenAccount: tokenAccount.publicKey,
  };
}

export async function lockComposition(
  program: anchor.Program,
  owner: anchor.web3.PublicKey,
  userState: anchor.web3.PublicKey,
  assetMints: anchor.web3.PublicKey[],
  tokenAccounts: anchor.web3.PublicKey[],
  compId: number,
  seed: number,
) {
  const composition = compositionPda(owner, compId);
  const lockRecords = assetMints.map((mint) => lockRecordPda(mint));
  const remainingAccounts = assetMints.flatMap((mint, index) => [
    { pubkey: tokenAccounts[index], isSigner: false, isWritable: false },
    { pubkey: lockRecords[index], isSigner: false, isWritable: true },
  ]);

  const tx = await program.methods
    .lockAndCompose(sceneKey(seed), assetMints)
    .accounts({
      userState,
      composition,
      authority: owner,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .transaction();

  await sendTransactionWithLogs(
    program.provider as anchor.AnchorProvider,
    tx,
    [],
    `lock_and_compose #${compId}`,
  );

  return { composition, lockRecords };
}

export async function dismantleComposition(
  program: anchor.Program,
  owner: anchor.web3.PublicKey,
  composition: anchor.web3.PublicKey,
  lockRecords: anchor.web3.PublicKey[],
) {
  const tx = await program.methods
    .dismantleComposition()
    .accounts({
      composition,
      owner,
    })
    .remainingAccounts(
      lockRecords.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    )
    .transaction();

  await sendTransactionWithLogs(
    program.provider as anchor.AnchorProvider,
    tx,
    [],
    "dismantle_composition",
  );
}

export async function sendTransactionWithLogs(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = [],
  label = "transaction",
) {
  logStep(`Sending ${label}`);

  const walletSigner = (provider.wallet as typeof provider.wallet & {
    payer?: anchor.web3.Signer;
  }).payer;
  const allSigners = walletSigner ? [walletSigner, ...signers] : signers;
  tx.feePayer = tx.feePayer ?? provider.wallet.publicKey;
  const latestBlockhash = await provider.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
  if (allSigners.length > 0) {
    tx.partialSign(...allSigners);
  }

  await simulateTransactionWithLogs(provider, tx, allSigners, label);

  const signature = await anchor.web3.sendAndConfirmTransaction(
    provider.connection,
    tx,
    allSigners,
    {
      skipPreflight: false,
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      maxRetries: 3,
    },
  );

  console.log(`  signature: ${signature}`);
  console.log(`  status: confirmed`);
  return signature;
}

async function simulateTransactionWithLogs(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[],
  label: string,
) {
  const simulationTx = anchor.web3.Transaction.from(
    tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );

  const simulation =
    signers.length > 0
      ? await provider.connection.simulateTransaction(simulationTx, signers)
      : await provider.connection.simulateTransaction(simulationTx);

  const logs = simulation.value.logs?.join("\n") ?? "(no logs available)";
  console.log(`  simulation logs for ${label}:\n${logs}`);

  if (simulation.value.err) {
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
}

function initializeMint2Ix(
  mint: anchor.web3.PublicKey,
  mintAuthority: anchor.web3.PublicKey,
) {
  const data = Buffer.concat([
    Buffer.from([20, 0]),
    mintAuthority.toBuffer(),
    Buffer.from([0]),
  ]);

  return new anchor.web3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

function initializeAccount3Ix(
  account: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey,
  owner: anchor.web3.PublicKey,
) {
  const data = Buffer.concat([Buffer.from([18]), owner.toBuffer()]);

  return new anchor.web3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function mintToIx(
  mint: anchor.web3.PublicKey,
  destination: anchor.web3.PublicKey,
  authority: anchor.web3.PublicKey,
  amount: bigint,
) {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const data = Buffer.concat([Buffer.from([7]), amountBuf]);

  return new anchor.web3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}
