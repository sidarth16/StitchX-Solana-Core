import * as fs from "node:fs";
import * as path from "node:path";

import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export const STITCHX_ASSET_COLLECTION_NAME = "StitchX Assets";
export const STITCHX_ASSET_COLLECTION_SYMBOL = "STITCHX";

const STITCHX_ASSET_COLLECTION_CACHE = path.resolve(
  "scripts/.stitchx-assets-collection.json",
);

export type PreviewAsset = {
  absolutePath: string;
  category: string;
  collection: string;
  encodedId: string;
  localImagePath: string;
  metadataUri: string;
  imageUri: string;
  imageCid: string;
  metadataCid: string;
  name: string;
  layer: string;
  renderer: string;
  relativePath: string;
  mimeType: string;
};

function loadLocalEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadLocalEnvFile();

export type MintBatchOptions = {
  rpcUrl: string;
  walletPath: string;
  recipientAddress?: string | null;
  assetRoot: string;
  folderFilter?: string[] | null;
  batchLabel: string;
};

type PinataUploadResult = {
  cid: string;
  gatewayUrl: string;
};

type StitchXAssetCollectionCache = {
  mint: string;
  imageCid?: string;
  metadataCid?: string;
  imageUri?: string;
  metadataUri?: string;
};

function getEnvValue(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  return null;
}

function pinataCredentials() {
  const apiKey = getEnvValue("PINATA_API_KEY", "PINATA_API_Key");
  const apiSecret = getEnvValue("PINATA_API_SECRET", "PINATA_API_Secret");

  if (!apiKey || !apiSecret) {
    throw new Error("Pinata credentials are not configured on the server.");
  }

  return { apiKey, apiSecret };
}

function pinataHeaders() {
  const { apiKey, apiSecret } = pinataCredentials();
  return {
    pinata_api_key: apiKey,
    pinata_secret_api_key: apiSecret,
  };
}

function pinataIpfsUri(cid: string) {
  return `ipfs://${cid}`;
}

async function readJsonResponse(response: Response) {
  const raw = await response.text().catch(() => "");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function extractPinataCid(payload: Record<string, unknown>) {
  return (
    String(payload.IpfsHash || payload.ipfsHash || payload.Hash || "").trim() ||
    null
  );
}

async function pinJsonToPinata(
  json: Record<string, unknown>,
  name: string,
): Promise<PinataUploadResult> {
  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      ...pinataHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: json,
      pinataMetadata: { name },
    }),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Pinata JSON upload failed (HTTP ${response.status}): ${
        (payload as { raw?: string; error?: string }).error ||
        (payload as { raw?: string }).raw ||
        response.statusText
      }`,
    );
  }

  const cid = extractPinataCid(payload as Record<string, unknown>);
  if (!cid) {
    throw new Error("Pinata JSON upload returned no CID.");
  }

  return {
    cid,
    gatewayUrl: pinataIpfsUri(cid),
  };
}

async function pinFileToPinata({
  buffer,
  fileName,
  mimeType,
}: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<PinataUploadResult> {
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), fileName);
  formData.append(
    "pinataMetadata",
    JSON.stringify({
      name: fileName,
    }),
  );

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: pinataHeaders(),
    body: formData,
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Pinata file upload failed (HTTP ${response.status}): ${
        (payload as { raw?: string; error?: string }).error ||
        (payload as { raw?: string }).raw ||
        response.statusText
      }`,
    );
  }

  const cid = extractPinataCid(payload as Record<string, unknown>);
  if (!cid) {
    throw new Error("Pinata file upload returned no CID.");
  }

  return {
    cid,
    gatewayUrl: pinataIpfsUri(cid),
  };
}

function resolveRendererLabel(assetRoot: string) {
  const normalized = assetRoot.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/interior")) {
    return "Interior";
  }
  return "Gaming Avatar";
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

function shortKey(value: string) {
  if (!value) return "";
  const s = String(value);
  return s.length <= 12 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
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

function deriveNameFromFile(fileName: string) {
  const withoutPrefix = fileName.replace(/^prev-/i, "");
  const withoutExtension = withoutPrefix.replace(/\.[^.]+$/, "");
  return titleCase(withoutExtension);
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

function sendJson(res: never, statusCode: number, payload: unknown) {
  const response = res as unknown as {
    writeHead: (code: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  };
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
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

function collectPreviewAssets(
  assetRoot: string,
  folderFilter: string[] | null = null,
): PreviewAsset[] {
  const results: PreviewAsset[] = [];
  const filterSet = folderFilter
    ? new Set(folderFilter.map((name) => name.toLowerCase()))
    : null;
  const renderer = resolveRendererLabel(assetRoot);

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
    const layer = titleCase(category);
    const name = deriveNameFromFile(fileName);
    results.push({
      absolutePath,
      category,
      collection: STITCHX_ASSET_COLLECTION_NAME,
      encodedId,
      localImagePath: path.join(assetRoot, relativePath),
      metadataUri: "",
      imageUri: "",
      imageCid: "",
      metadataCid: "",
      name,
      layer,
      renderer,
      relativePath,
      mimeType: contentTypeForFile(absolutePath),
    });
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function collectionCachePath() {
  return STITCHX_ASSET_COLLECTION_CACHE;
}

function readCollectionCache(): StitchXAssetCollectionCache | null {
  const cachePath = collectionCachePath();
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as StitchXAssetCollectionCache;
    if (!parsed?.mint) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCollectionCache(data: StitchXAssetCollectionCache) {
  const cachePath = collectionCachePath();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

function collectionBadgeSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0d1230"/>
      <stop offset="100%" stop-color="#070a16"/>
    </linearGradient>
    <radialGradient id="r" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#7c6fff" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#4fffb0" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="1200" rx="120" fill="url(#g)"/>
  <circle cx="600" cy="500" r="310" fill="url(#r)"/>
  <rect x="170" y="170" width="860" height="860" rx="80" fill="none" stroke="#4fffb0" stroke-width="6" stroke-opacity="0.25"/>
  <text x="600" y="560" text-anchor="middle" font-family="monospace" font-size="86" fill="#eef2ff" font-weight="700">StitchX Assets</text>
  <text x="600" y="650" text-anchor="middle" font-family="monospace" font-size="28" fill="#8f96ad">Verified collection</text>
</svg>`;
}

function buildCollectionMetadata(imageUri: string) {
  return {
    name: STITCHX_ASSET_COLLECTION_NAME,
    symbol: STITCHX_ASSET_COLLECTION_SYMBOL,
    description: "Verified collection for StitchX composable asset NFTs.",
    image: imageUri,
    attributes: [
      { trait_type: "Collection", value: STITCHX_ASSET_COLLECTION_NAME },
      { trait_type: "Renderer", value: "StitchX Protocol" },
    ],
    properties: {
      files: [
        {
          uri: imageUri,
          type: "image/svg+xml",
        },
      ],
      collection: STITCHX_ASSET_COLLECTION_NAME,
      creators: [],
    },
  };
}

async function uploadCollectionMetadataToPinata() {
  const imageUpload = await pinFileToPinata({
    buffer: Buffer.from(collectionBadgeSvg(), "utf8"),
    fileName: "stitchx-assets-collection.svg",
    mimeType: "image/svg+xml",
  });

  const metadata = buildCollectionMetadata(imageUpload.gatewayUrl);
  const metadataUpload = await pinJsonToPinata(
    metadata as Record<string, unknown>,
    STITCHX_ASSET_COLLECTION_NAME,
  );

  return {
    imageCid: imageUpload.cid,
    imageUri: imageUpload.gatewayUrl,
    metadataCid: metadataUpload.cid,
    metadataUri: metadataUpload.gatewayUrl,
  };
}

async function uploadAssetToPinata(asset: PreviewAsset) {
  const imageBytes = fs.readFileSync(asset.absolutePath);
  const imageUpload = await pinFileToPinata({
    buffer: imageBytes,
    fileName: path.basename(asset.absolutePath),
    mimeType: asset.mimeType,
  });

  const metadata = {
    name: asset.name,
    symbol: STITCHX_ASSET_COLLECTION_SYMBOL,
    description: `StitchX asset NFT for ${asset.name}.`,
    image: imageUpload.gatewayUrl,
    collection: {
      name: STITCHX_ASSET_COLLECTION_NAME,
    },
    attributes: [
      { trait_type: "Layer", value: asset.layer },
      { trait_type: "Renderer", value: asset.renderer },
    ],
    properties: {
      files: [
        {
          uri: imageUpload.gatewayUrl,
          type: asset.mimeType,
        },
      ],
      collection: STITCHX_ASSET_COLLECTION_NAME,
      layer: asset.layer,
      renderer: asset.renderer,
      creators: [],
    },
  };

  const metadataUpload = await pinJsonToPinata(
    metadata as Record<string, unknown>,
    asset.name,
  );

  return {
    ...asset,
    imageCid: imageUpload.cid,
    imageUri: imageUpload.gatewayUrl,
    metadataCid: metadataUpload.cid,
    metadataUri: metadataUpload.gatewayUrl,
  };
}

async function ensureStitchXAssetsCollection(connection: Connection, wallet: Keypair) {
  const metaplex = Metaplex.make(connection).use(keypairIdentity(wallet));
  const explicitMint = getEnvValue(
    "STITCHX_ASSET_COLLECTION_MINT",
    "ASSET_COLLECTION_MINT",
  );
  const cached = readCollectionCache();
  const candidateMint = explicitMint || cached?.mint || null;

  if (candidateMint) {
    try {
      const collectionNft = await metaplex.nfts().findByMint({
        mintAddress: new PublicKey(candidateMint),
      });
      if (collectionNft?.address) {
        return {
          mint: collectionNft.address,
          imageCid: cached?.imageCid || null,
          imageUri: cached?.imageUri || null,
          metadataCid: cached?.metadataCid || null,
          metadataUri: cached?.metadataUri || null,
          source: explicitMint ? "env" : "cache",
        };
      }
    } catch {
      if (explicitMint) {
        throw new Error(
          `STITCHX_ASSET_COLLECTION_MINT points to an invalid collection mint: ${candidateMint}`,
        );
      }
    }
  }

  const collectionUpload = await uploadCollectionMetadataToPinata();
  const { nft } = await metaplex.nfts().create({
    uri: collectionUpload.metadataUri,
    name: STITCHX_ASSET_COLLECTION_NAME,
    symbol: STITCHX_ASSET_COLLECTION_SYMBOL,
    sellerFeeBasisPoints: 0,
    isMutable: false,
    isCollection: true,
    tokenOwner: wallet.publicKey,
    updateAuthority: wallet,
  });

  const mint = nft.address.toBase58();
  const cacheRecord = {
    mint,
    imageCid: collectionUpload.imageCid,
    metadataCid: collectionUpload.metadataCid,
    imageUri: collectionUpload.imageUri,
    metadataUri: collectionUpload.metadataUri,
  };
  writeCollectionCache(cacheRecord);

  return {
    mint: nft.address,
    imageCid: collectionUpload.imageCid,
    imageUri: collectionUpload.imageUri,
    metadataCid: collectionUpload.metadataCid,
    metadataUri: collectionUpload.metadataUri,
    source: "created" as const,
  };
}

async function mintPreviewAsset({
  connection,
  wallet,
  recipient,
  asset,
  collectionMint,
}: {
  connection: Connection;
  wallet: Keypair;
  recipient: PublicKey;
  asset: PreviewAsset;
  collectionMint: PublicKey;
}) {
  const metaplex = Metaplex.make(connection).use(keypairIdentity(wallet));
  const { nft } = await metaplex.nfts().create({
    uri: asset.metadataUri,
    name: asset.name,
    symbol: STITCHX_ASSET_COLLECTION_SYMBOL,
    sellerFeeBasisPoints: 0,
    isMutable: false,
    tokenOwner: recipient,
    collection: collectionMint,
    collectionAuthority: wallet,
    collectionIsSized: true,
  });

  let verifiedNft = nft;
  if (!verifiedNft.collection?.verified) {
    await metaplex.nfts().verifyCollection({
      mintAddress: nft.address,
      collectionMintAddress: collectionMint,
      collectionAuthority: wallet,
      isSizedCollection: true,
    });
    verifiedNft = await metaplex.nfts().findByMint({
      mintAddress: nft.address,
    });
  }

  const signatures = await connection.getSignaturesForAddress(nft.address, {
    limit: 1,
  });
  const signature = signatures[0]?.signature ?? "unknown";

  return {
    mint: verifiedNft.address,
    signature,
    collectionVerified: Boolean(verifiedNft.collection?.verified),
  };
}

export async function runStitchXAssetMintBatch({
  rpcUrl,
  walletPath,
  recipientAddress,
  assetRoot,
  folderFilter = null,
  batchLabel,
}: MintBatchOptions) {
  const wallet = loadKeypair(expandHome(walletPath));
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

  const assets = collectPreviewAssets(assetRoot, folderFilter);
  if (assets.length === 0) {
    throw new Error(`No preview assets found under ${assetRoot}`);
  }

  logStep(`Starting ${batchLabel}`, {
    rpcUrl,
    wallet: wallet.publicKey.toBase58(),
    recipient: recipient.toBase58(),
    assetRoot,
    assets: assets.length,
    collection: STITCHX_ASSET_COLLECTION_NAME,
  });

  const collection = await ensureStitchXAssetsCollection(connection, wallet);
  logStep("Using StitchX Assets collection", {
    mint: collection.mint.toBase58(),
    imageCid: collection.imageCid || "n/a",
    metadataCid: collection.metadataCid || "n/a",
    source: collection.source,
  });

  for (const asset of assets) {
    const uploadedAsset = await uploadAssetToPinata(asset);
    const { mint, signature, collectionVerified } = await mintPreviewAsset({
      connection,
      wallet,
      recipient,
      asset: uploadedAsset,
      collectionMint: collection.mint,
    });

    console.log(
      JSON.stringify(
        {
          name: asset.name,
          mint: mint.toBase58(),
          collection: STITCHX_ASSET_COLLECTION_NAME,
          collectionMint: collection.mint.toBase58(),
          collectionVerified,
          layer: asset.layer,
          renderer: asset.renderer,
          imageCid: uploadedAsset.imageCid,
          metadataCid: uploadedAsset.metadataCid,
          imageUri: uploadedAsset.imageUri,
          metadataUri: uploadedAsset.metadataUri,
          transactionSignature: signature,
        },
        null,
        2,
      ),
    );
  }
}
