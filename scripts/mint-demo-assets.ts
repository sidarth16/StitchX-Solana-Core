import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

type PreviewAsset = {
  absolutePath: string;
  category: string;
  collection: string;
  encodedId: string;
  localImagePath: string;
  metadataUrl: string;
  imageUrl: string;
  name: string;
  relativePath: string;
};

type MetadataServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletPath = expandHome(
    process.env.WALLET_PATH ?? process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json",
  );
  const recipientAddress = process.env.RECIPIENT_WALLET ?? process.env.MINT_TO_WALLET;
  const assetRoot = path.resolve(process.env.ASSET_ROOT ?? "app/public/assets/avatar");
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

  const assets = collectPreviewAssets(assetRoot);
  if (assets.length === 0) {
    throw new Error(`No preview assets found under ${assetRoot}`);
  }

  const metadataServer = explicitBaseUrl
    ? null
    : await startMetadataServer(metadataPort, assets);
  const baseUrl = explicitBaseUrl ?? metadataServer?.baseUrl ?? `http://127.0.0.1:${metadataPort}`;
  const resolvedAssets = assets.map((asset) => ({
    ...asset,
    imageUrl: `${baseUrl}/image/${asset.encodedId}`,
    metadataUrl: `${baseUrl}/metadata/${asset.encodedId}`,
  }));

  logStep("Starting StitchX demo NFT mint", {
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

async function mintOneAsset({
  connection,
  wallet,
  recipient,
  asset,
}: {
  connection: Connection;
  wallet: Keypair;
  recipient: PublicKey;
  asset: PreviewAsset;
}) {
  const metaplex = Metaplex.make(connection).use(keypairIdentity(wallet));
  const { nft } = await metaplex.nfts().create({
    uri: asset.metadataUrl,
    name: asset.name,
    symbol: "STITCHX",
    sellerFeeBasisPoints: 0,
    isMutable: false,
    tokenOwner: recipient,
  });

  const signatures = await connection.getSignaturesForAddress(nft.address, { limit: 1 });
  const signature = signatures[0]?.signature ?? "unknown";
  return { mint: nft.address, signature };
}

async function startMetadataServer(port: number, assets: PreviewAsset[]): Promise<MetadataServer> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const assetById = new Map<string, PreviewAsset>();
  for (const asset of assets) {
    assetById.set(asset.encodedId, asset);
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (url.startsWith("/image/")) {
      const encodedId = decodeURIComponent(url.slice("/image/".length));
      const asset = assetById.get(encodedId);
      if (!asset) {
        sendJson(res, 404, { error: "asset not found" });
        return;
      }

      fs.createReadStream(asset.absolutePath)
        .on("error", (error) => {
          sendJson(res, 500, { error: String(error) });
        })
        .once("open", () => {
          res.writeHead(200, { "content-type": contentTypeForFile(asset.absolutePath) });
        })
        .pipe(res);
      return;
    }

    if (url.startsWith("/metadata/")) {
      const encodedId = decodeURIComponent(url.slice("/metadata/".length));
      const asset = assetById.get(encodedId);
      if (!asset) {
        sendJson(res, 404, { error: "asset not found" });
        return;
      }

      const metadata = {
        name: asset.name,
        symbol: "STITCHX",
        description: `StitchX preview asset from ${asset.collection}.`,
        image: `${baseUrl}/image/${asset.encodedId}`,
        attributes: [
          { trait_type: "collection", value: asset.collection },
          { trait_type: "source_path", value: asset.localImagePath },
        ],
        properties: {
          files: [
            {
              uri: `${baseUrl}/image/${asset.encodedId}`,
              type: contentTypeForFile(asset.absolutePath),
            },
          ],
          category: asset.collection,
          creators: [],
        },
      };

      sendJson(res, 200, metadata);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function collectPreviewAssets(assetRoot: string): PreviewAsset[] {
  const results: PreviewAsset[] = [];

  for (const absolutePath of walkFiles(assetRoot)) {
    const relativePath = path.relative(assetRoot, absolutePath);
    const parts = relativePath.split(path.sep);
    const fileName = parts[parts.length - 1];
    if (!fileName.toLowerCase().startsWith("prev-")) {
      continue;
    }

    const encodedId = encodeURIComponent(relativePath.split(path.sep).join("/"));
    const category = parts[0] ?? "uncategorized";
    const collection = titleCase(category);
    const name = deriveNameFromFile(fileName);
    results.push({
      absolutePath,
      category,
      collection,
      encodedId,
      localImagePath: path.join("app/public/assets/avatar", relativePath),
      imageUrl: "",
      metadataUrl: "",
      name,
      relativePath,
    });
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function walkFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const entries: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop() as string;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }

      if (entry.isFile()) {
        entries.push(absolute);
      }
    }
  }

  return entries;
}

function deriveNameFromFile(fileName: string): string {
  const withoutPrefix = fileName.replace(/^prev-/i, "");
  const withoutExtension = withoutPrefix.replace(/\.[^.]+$/, "");
  return titleCase(withoutExtension);
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function contentTypeForFile(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function loadKeypair(walletPath: string) {
  const raw = fs.readFileSync(walletPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secretKey);
}

function expandHome(input: string) {
  if (!input.startsWith("~")) {
    return input;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    return input;
  }

  return path.join(home, input.slice(1));
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function waitForShutdown(server: MetadataServer) {
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await server.close();
      resolve();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function logStep(title: string, details?: Record<string, string | number | boolean>) {
  console.log(`\n=== ${title} ===`);
  if (!details) {
    return;
  }
  for (const [key, value] of Object.entries(details)) {
    console.log(`  ${key}: ${value}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
