import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { secureHeaders } from "hono/secure-headers";
import { nwc } from "npm:@getalby/sdk";
import { LOG_LEVEL, logger, loggerMiddleware } from "./logger.ts";

export const PORT = parseInt(Deno.env.get("PORT") || "8080");

const hono = new Hono();

hono.use(loggerMiddleware());
hono.use(secureHeaders());
hono.use(cors());

function getLnurlMetadata(name: string): string {
  return JSON.stringify([
    ["text/identifier", `${name}`],
    ["text/plain", `Sats for ${name}`],
  ]);
}

function base64UrlEncode(str: string) {
  const base64 = btoa(str);
  return base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string) {
  let base64 = str
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  // Pad with '=' characters to make the length a multiple of 4
  while (base64.length % 4) {
    base64 += "=";
  }
  return atob(base64);
}

hono.get("/lnurlp/:name/:nwc", (c) => {
  const url = new URL(c.req.url);
  const encodedConnectionString = c.req.param("nwc");
  const name = c.req.param("name");
  return c.json({
    tag: "payRequest",
    commentAllowed: 255,
    callback: `${url.origin}/callback/${name}/${encodedConnectionString}`,
    minSendable: 1000,
    maxSendable: 10000000000,
    metadata: getLnurlMetadata(name),
    payerData: {
      name: {
        mandatory: false,
      },
      email: {
        mandatory: false,
      },
      pubkey: {
        mandatory: false,
      },
    },
  });
});

hono.get("/callback/:name/:nwc", async (c) => {
  try {
    const url = new URL(c.req.url);
    const encodedConnectionString = c.req.param("nwc");
    const name = c.req.param("name");

    const amount = c.req.query("amount");
    const comment = c.req.query("comment") || "";
    const payerData = c.req.query("payerdata")
      ? JSON.parse(c.req.query("payerdata") || "")
      : null;

    logger.debug("LNURLp callback", { name, amount, comment });

    if (!amount) {
      throw new Error("No amount provided");
    }

    const connectionSecret = base64UrlDecode(encodedConnectionString);

    const nwcClient = new nwc.NWCClient({
      nostrWalletConnectUrl: connectionSecret,
    });

    const transaction = await nwcClient.makeInvoice({
      amount: Math.floor(+amount / 1000) * 1000,
      description: comment,
      metadata: {
        comment: comment || undefined,
        payer_data: payerData || undefined,
      },
    });

    return c.json({
      verify:
        `${url.origin}/verify/${name}/${encodedConnectionString}/${transaction.payment_hash}`,
      routes: [],
      pr: transaction.invoice,
    });
  } catch (error) {
    return c.json({ status: "ERROR", reason: "" + error });
  }
});

hono.get("/verify/:name/:nwc/:payment_hash", async (c) => {
  try {
    const encodedConnectionString = c.req.param("nwc");
    const paymentHash = c.req.param("payment_hash");

    const connectionSecret = base64UrlDecode(encodedConnectionString);

    const nwcClient = new nwc.NWCClient({
      nostrWalletConnectUrl: connectionSecret,
    });

    const transaction = await nwcClient.lookupInvoice({
      payment_hash: paymentHash,
    });

    return c.json({
      "status": "OK",
      "settled": transaction.state === "settled",
      "preimage":
        (transaction.state === "settled" ? transaction.preimage : null),
      "pr": transaction.invoice,
    });
  } catch (error) {
    return c.json({ status: "ERROR", reason: "" + error });
  }
});

hono.get("/ping", (c) => {
  return c.body("pong", 200);
});

hono.get("/robots.txt", (c) => {
  return c.body("User-agent: *\nDisallow: /", 200);
});

hono.use("/", serveStatic({ path: "./index.html" }));

hono.use("/favicon.ico", serveStatic({ path: "./favicon.ico" }));

Deno.serve({ port: PORT }, hono.fetch);

logger.info("Server started", { port: PORT, log_level: LOG_LEVEL });
