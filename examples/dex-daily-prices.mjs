import { createDataClient } from "@blockvectra/data-api";

const required = [
  "BLOCKVECTRA_API_KEY",
  "BLOCKVECTRA_CHAIN",
  "BLOCKVECTRA_TOKEN",
  "BLOCKVECTRA_QUOTE",
  "BLOCKVECTRA_FROM",
  "BLOCKVECTRA_TO",
];

const env = {};
for (const name of required) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    console.error(`Missing or blank required environment variable: ${name}`);
    process.exit(1);
  }
  env[name] = value;
}

const client = createDataClient({ apiKey: env.BLOCKVECTRA_API_KEY });

try {
  const { data, response } = await client.GET("/{chain}/dex/prices", {
    params: {
      path: { chain: env.BLOCKVECTRA_CHAIN },
      query: {
        token: env.BLOCKVECTRA_TOKEN,
        quote: env.BLOCKVECTRA_QUOTE,
        from: env.BLOCKVECTRA_FROM,
        to: env.BLOCKVECTRA_TO,
      },
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    console.error(`Data API request failed: HTTP ${response.status}`);
    process.exit(1);
  }

  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof data.meta !== "object" ||
    data.meta === null ||
    Array.isArray(data.meta) ||
    !Array.isArray(data.data)
  ) {
    console.error("Data API returned an invalid response envelope.");
    process.exit(1);
  }

  console.log(JSON.stringify(data));
} catch {
  console.error("Data API request failed: network error, timeout, or invalid JSON.");
  process.exit(1);
}
