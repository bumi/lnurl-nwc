import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { secureHeaders } from "hono/secure-headers";
import { nwc } from "npm:@getalby/sdk";
import { bech32 } from "npm:bech32";
import { LOG_LEVEL, logger, loggerMiddleware } from "./logger.ts";

interface Lnurl {
  name: string;
  connectionSecret: string;
  commentAllowed?: boolean;
  payerDataAllowed?: boolean;
  minSendable?: number;
  maxSendable?: number;
  successMessage?: string;
  successUrl?: string;
}

export const PORT = parseInt(Deno.env.get("PORT") || "8080");

const kv = await Deno.openKv();
const hono = new Hono();

function encodeLnurl(url: string): string {
  const words = bech32.toWords(new TextEncoder().encode(url));
  return bech32.encode("lnurl", words, 2000);
}

hono.use(loggerMiddleware());
hono.use(secureHeaders());
hono.use(cors());

function getLnurlMetadata(lnurl: Lnurl): string {
  return JSON.stringify([
    ["text/identifier", `${lnurl.name || "unknown"}`],
    ["text/plain", `Sats for ${lnurl.name || "unknown"}`],
  ]);
}

hono.get("/lnurlp/:uuid", async (c) => {
  const url = new URL(c.req.url);
  const uuid = c.req.param("uuid");

  const lnurlEntry = await kv.get<Lnurl>(["lnurls", uuid]);
  const lnurl = lnurlEntry.value;
  if (!lnurl) {
    return c.json({ status: "ERROR", reason: "not found" });
  }

  const res = {
    tag: "payRequest",
    commentAllowed: (lnurl.commentAllowed ? 255 : false),
    callback: `${url.origin}/callback/${uuid}`,
    minSendable: (lnurl.minSendable || 1) * 1000,
    maxSendable: (lnurl.maxSendable || 1000000) * 1000,
    metadata: getLnurlMetadata(lnurl),
  };
  if (lnurl.payerDataAllowed) {
    res.payerData = {
      name: {
        mandatory: false,
      },
      email: {
        mandatory: false,
      },
      pubkey: {
        mandatory: false,
      },
    }
  }

  return c.json(res);
});

hono.get("/callback/:uuid", async (c) => {
  try {
    const url = new URL(c.req.url);
    const uuid = c.req.param("uuid");

    const lnurlEntry = await kv.get<Lnurl>(["lnurls", uuid]);
    const lnurl = lnurlEntry.value;
    if (!lnurl) {
      throw new Error("not found");
    }

    const amount = +c.req.query("amount");
    const comment = c.req.query("comment") || "";
    const payerData = c.req.query("payerdata")
      ? JSON.parse(c.req.query("payerdata") || "")
      : null;

    if (!amount) {
      throw new Error("No amount provided");
    }
    const amountInSatoshis = Math.floor(amount / 1000);
    if (lnurl.maxSendable && amountInSatoshis > lnurl.maxSendable) {
      throw new Error("Amount too high");
    }
    if (lnurl.minSendable && amountInSatoshis < lnurl.minSendable) {
      throw new Error("Amount too low");
    }

    let connectionSecret = lnurl.connectionSecret;
    const nwcClient = new nwc.NWCClient({
      nostrWalletConnectUrl: connectionSecret,
    });

    const transaction = await nwcClient.makeInvoice({
      amount: amount,
      description: comment,
      metadata: {
        comment: comment || undefined,
        payer_data: payerData || undefined,
      },
    });

    const res = {
      verify:
        `${url.origin}/verify/${uuid}/${transaction.payment_hash}`,
      routes: [],
      pr: transaction.invoice,
    }
    if (lnurl.successMessage && !lnurl.successUrl) {
      res.successAction = {
        "tag": "message",
        "message": lnurl.successMessage
      }
    } else if (lnurl.successUrl) {
      res.successAction = {
        "tag": "url",
        "url": lnurl.successUrl
      }
      if (lnurl.successMessage) {
        res.successAction.description = lnurl.successMessage;
      }
    };

    return c.json(res)
  } catch (error) {
    return c.json({ status: "ERROR", reason: "" + error });
  }
});

hono.get("/verify/:uuid/:payment_hash", async (c) => {
  try {
    const uuid = c.req.param("uuid");

    const lnurlEntry = await kv.get<Lnurl>(["lnurls", uuid]);
    const lnurl = lnurlEntry.value;
    if (!lnurl) {
      return c.json({ status: "ERROR", reason: "not found" });
    }

    const paymentHash = c.req.param("payment_hash");

    let connectionSecret = lnurl.connectionSecret;
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

hono.post("/create", async (c) => {
  const url = new URL(c.req.url);

  const json = await c.req.json();

  const uuid = crypto.randomUUID();

  const lnurl = {
    name: json.name,
    connectionSecret: json.connectionSecret,
    minSendable: json.minSendable,
    maxSendable: json.maxSendable,
    commentAllowed: json.commentAllowed,
    payerDataAllowed: json.payerDataAllowed,
    successMessage: json.successMessage,
    successUrl: json.successUrl
  };

  try {
    const nwcClient = new nwc.NWCClient({
      nostrWalletConnectUrl: lnurl.connectionSecret,
    });
    const info = await nwcClient.getInfo();
    if (!info.methods || info.methods.includes("pay_invoice") || info.methods.includes("pay_keysend")) {
      throw new Error("Use a readonly connection");
    }
  } catch (error) {
    return c.json({ error: "review your connection secret and make sure it's a readonly connection" });
  }

  await kv.set(["lnurls", uuid], lnurl);

  const endpoint = `${url.origin}/lnurlp/${uuid}`;
  const endpointEncoded = encodeLnurl(endpoint);
  return c.json({
    uuid,
    url: endpoint,
    lnurl: endpointEncoded
  });
});

hono.get("/ping", (c) => {
  return c.body("pong", 200);
});

hono.get("/robots.txt", (c) => {
  return c.body("User-agent: *\nDisallow: /", 200);
});

hono.use("/", serveStatic({ path: "./lnurl.html" }));

hono.use("/favicon.ico", serveStatic({ path: "./favicon.ico" }));

Deno.serve({ port: PORT }, hono.fetch);

logger.info("Server started", { port: PORT, log_level: LOG_LEVEL });
