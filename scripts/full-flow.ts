if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const anchor: typeof import("@anchor-lang/core") = require("@anchor-lang/core");
import {
  compositionPda,
  createSampleAsset,
  dismantleComposition,
  ensureWalletFunding,
  getProgram,
  getProvider,
  lockComposition,
  logStep,
  sceneKey,
  sendTransactionWithLogs,
  userStatePda,
} from "./stitchx-shared";

async function main() {
  const provider = getProvider();
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;

  logStep("Starting StitchX local flow", {
    cluster: provider.connection.rpcEndpoint,
    wallet: owner.toBase58(),
  });
  await ensureWalletFunding(provider);

  const userState = userStatePda(owner);
  const initUserTx = await program.methods
    .initializeUser()
    .accounts({
      authority: owner,
      userState,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .transaction();
  const sig = await sendTransactionWithLogs(provider, initUserTx, [], "initialize_user");
  console.log("initialize_user tx:", sig);
  logStep("User state initialized", { userState: userState.toBase58() });

  const assetA = await createSampleAsset(provider, owner);
  const assetB = await createSampleAsset(provider, owner);

  logStep("Locking initial composition", {
    assetA: assetA.mint.toBase58(),
    assetB: assetB.mint.toBase58(),
  });
  const first = await lockComposition(
    program,
    owner,
    userState,
    [assetA.mint, assetB.mint],
    [assetA.tokenAccount, assetB.tokenAccount],
    0,
    7,
  );
  logStep("First composition locked", {
    composition: first.composition.toBase58(),
    lockA: first.lockRecords[0].toBase58(),
    lockB: first.lockRecords[1].toBase58(),
  });

  const userStateAccount = await program.account.userState.fetch(userState);
  logStep("User state after first lock", {
    compositionCount: userStateAccount.compositionCount.toString(),
  });

  const conflictComposition = compositionPda(owner, 1);
  logStep("Attempting conflicting compose", {
    composition: conflictComposition.toBase58(),
    asset: assetA.mint.toBase58(),
  });
  try {
    const conflictTx = await program.methods
      .lockAndCompose(sceneKey(8), [assetA.mint])
      .accounts({
        userState,
        composition: conflictComposition,
        authority: owner,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: assetA.tokenAccount, isSigner: false, isWritable: false },
        { pubkey: first.lockRecords[0], isSigner: false, isWritable: true },
      ])
      .transaction();
    await sendTransactionWithLogs(provider, conflictTx, [], "conflicting_lock_and_compose");
    throw new Error("conflicting compose unexpectedly succeeded");
  } catch (err) {
    logStep("Conflicting compose failed as expected");
    console.log(String(err));
  }

  logStep("Dismantling composition", { composition: first.composition.toBase58() });
  await dismantleComposition(program, owner, first.composition, first.lockRecords);
  logStep("Composition dismantled", { composition: first.composition.toBase58() });

  logStep("Reusing unlocked assets", {
    assetA: assetA.mint.toBase58(),
    assetB: assetB.mint.toBase58(),
  });
  const reused = await lockComposition(
    program,
    owner,
    userState,
    [assetA.mint, assetB.mint],
    [assetA.tokenAccount, assetB.tokenAccount],
    1,
    9,
  );
  logStep("Reused assets successfully", {
    composition: reused.composition.toBase58(),
    lockA: reused.lockRecords[0].toBase58(),
    lockB: reused.lockRecords[1].toBase58(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
