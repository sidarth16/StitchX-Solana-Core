import { getProgram, getProvider, PROGRAM_ID } from "./stitchx-shared";

async function main() {
  const provider = getProvider();
  const program = getProgram(provider);
  const programAccount = await provider.connection.getAccountInfo(PROGRAM_ID);

  console.log("provider:", provider.connection.rpcEndpoint);
  console.log("wallet:", provider.wallet.publicKey.toBase58());
  console.log("program id:", PROGRAM_ID.toBase58());
  console.log("idl address:", program.idl.address);
  console.log("program account exists:", Boolean(programAccount));
  console.log("program account executable:", programAccount?.executable ?? false);

  if (!programAccount) {
    throw new Error("StitchX is not deployed at the expected program id yet.");
  }

  if (program.idl.address !== PROGRAM_ID.toBase58()) {
    throw new Error("IDL address does not match the program id.");
  }

  console.log("verified on-chain program account owner:", programAccount.owner.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
