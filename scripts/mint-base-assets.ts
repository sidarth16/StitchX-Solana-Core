import { Connection, PublicKey } from "@solana/web3.js";

import {
  collectPreviewAssets,
  expandHome,
  loadKeypair,
  logStep,
  mintOneAsset,
  startMetadataServer,
  TOKEN_METADATA_PROGRAM_ID,
  waitForShutdown,
} from "./mint-preview-assets.shared";

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletPath = expandHome(
    process.env.WALLET_PATH ?? process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json",
  );
  const recipientAddress = process.env.RECIPIENT_WALLET ?? process.env.MINT_TO_WALLET;
  const assetRoot = process.env.ASSET_ROOT ?? "app/public/assets/avatar/base";
  const explicitBaseUrl = process.env.METADATA_BASE_URL?.replace(/\/$/, "");
  const metadataPort = Number(process.env.METADATA_SERVER_PORT ?? 3333);
  const keepServerAlive = process.env.EXIT_AFTER_MINT !== "1";

  const wallet = loadKeypair(walletPath);
  const recipient = recipientAddress ? new PublicKey(recipientAddress) : wallet.publicKey;
  const connection = new Connection(rpcUrl, "confirmed");
  const programAccount = await connection.getAccountInfo(TOKEN_METADATA_PROGRAM_ID);
  if (!programAccount?.executable) {
    throw new Error(
      [
        `Metaplex token metadata program is not available on ${rpcUrl}.`,
        "Use devnet, or start local validator with the token metadata program deployed before running this script.",
      ].join(" "),
    );
  }

  const assets = collectPreviewAssets(assetRoot, ["base"]);
  if (assets.length === 0) {
    throw new Error(`No base preview assets found under ${assetRoot}`);
  }

  const metadataServer = explicitBaseUrl
    ? null
    : await startMetadataServer(metadataPort, assets);
  const baseUrl =
    explicitBaseUrl ?? metadataServer?.baseUrl ?? `http://127.0.0.1:${metadataPort}`;
  const resolvedAssets = assets.map((asset) => ({
    ...asset,
    imageUrl: `${baseUrl}/image/${asset.encodedId}`,
    metadataUrl: `${baseUrl}/metadata/${asset.encodedId}`,
  }));

  logStep("Starting StitchX base NFT mint", {
    rpcUrl,
    wallet: wallet.publicKey.toBase58(),
    recipient: recipient.toBase58(),
    assetRoot,
    assets: resolvedAssets.length,
    metadataBaseUrl: baseUrl,
  });

  for (const asset of resolvedAssets) {
    const { mint, signature } = await mintOneAsset({
      connection,
      wallet,
      recipient,
      asset,
    });

    console.log(
      JSON.stringify(
        {
          name: asset.name,
          collection: asset.collection,
          mint: mint.toBase58(),
          recipient: recipient.toBase58(),
          localImagePath: asset.localImagePath,
          transactionSignature: signature,
        },
        null,
        2,
      ),
    );
  }

  if (metadataServer && keepServerAlive) {
    logStep("Metadata server still running", {
      baseUrl,
      note: "Keep this terminal open so Phantom can keep fetching the preview image and JSON.",
    });
    await waitForShutdown(metadataServer);
  }

  if (metadataServer && !keepServerAlive) {
    await metadataServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
