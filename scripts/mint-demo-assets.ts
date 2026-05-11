import { runStitchXAssetMintBatch } from "./mint-preview-assets.shared";

async function main() {
  await runStitchXAssetMintBatch({
    rpcUrl:
      process.env.RPC_URL ??
      process.env.ANCHOR_PROVIDER_URL ??
      "http://127.0.0.1:8899",
    walletPath:
      process.env.WALLET_PATH ??
      process.env.ANCHOR_WALLET ??
      "~/.config/solana/id.json",
    recipientAddress: process.env.RECIPIENT_WALLET ?? process.env.MINT_TO_WALLET,
    assetRoot: process.env.ASSET_ROOT ?? "app/public/assets/avatar",
    folderFilter: null,
    batchLabel: "StitchX demo NFT mint",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
