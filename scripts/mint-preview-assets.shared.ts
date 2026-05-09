import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export type PreviewAsset = {
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

export type MetadataServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export function collectPreviewAssets(
  assetRoot: string,
  folderFilter: string[] | null = null,
): PreviewAsset[] {
  const results: PreviewAsset[] = [];
  const filterSet = folderFilter ? new Set(folderFilter.map((name) => name.toLowerCase())) : null;

  for (const absolutePath of walkFiles(assetRoot)) {
    const relativePath = path.relative(assetRoot, absolutePath);
    const parts = relativePath.split(path.sep);
    const fileName = parts[parts.length - 1];
    if (!fileName.toLowerCase().startsWith("prev-")) {
      continue;
    }

    const category = (parts.length > 1 ? parts[0] : path.basename(assetRoot)).toLowerCase();
    if (filterSet && !filterSet.has(category)) {
      continue;
    }

    const encodedId = encodeURIComponent(relativePath.split(path.sep).join("/"));
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

export async function mintOneAsset({
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

export async function startMetadataServer(
  port: number,
  assets: PreviewAsset[],
): Promise<MetadataServer> {
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

  const boundPort = await bindMetadataServer(server, port);
  const baseUrl = `http://127.0.0.1:${boundPort}`;

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

async function bindMetadataServer(server: http.Server, preferredPort: number) {
  const listen = (listenPort: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("error", onError);
        reject(error);
      };

      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Metadata server did not return a usable address."));
          return;
        }
        resolve(address.port);
      });
    });

  try {
    return await listen(preferredPort);
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EADDRINUSE" &&
      preferredPort !== 0
    ) {
      console.warn(
        `Metadata server port ${preferredPort} is busy, falling back to an ephemeral port.`,
      );
      return await listen(0);
    }
    throw error;
  }
}

export async function waitForShutdown(server: MetadataServer) {
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await server.close();
      resolve();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export function loadKeypair(walletPath: string) {
  const raw = fs.readFileSync(walletPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secretKey);
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

export function logStep(title: string, details?: Record<string, string | number | boolean>) {
  console.log(`\n=== ${title} ===`);
  if (!details) {
    return;
  }
  for (const [key, value] of Object.entries(details)) {
    console.log(`  ${key}: ${value}`);
  }
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

function titleCase(value: string) {
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

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
