// @ts-nocheck
import type { APIRoute } from "astro";
import tls from "node:tls";

export const prerender = false;

const MAX_FIELD_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 1600;
const CONTACT_TOPICS = new Set(["Reservierung", "Gruppenabend", "Feedback", "Allgemeine Anfrage"]);

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const wantsJson = (request: Request) => request.headers.get("accept")?.includes("application/json");

const clean = (value: FormDataEntryValue | null, maxLength = MAX_FIELD_LENGTH) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const cleanMessage = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const encodeHeader = (value: string) => `=?UTF-8?B?${Buffer.from(value.replace(/[\r\n]+/g, " "), "utf8").toString("base64")}?=`;

const formatAddress = (name: string, email: string) => `${encodeHeader(name)} <${email}>`;

const dotStuff = (value: string) => value.replace(/\n\./g, "\n..").replace(/\n/g, "\r\n");

const readSmtpResponseFactory = (socket: tls.TLSSocket) => {
  let buffer = "";
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];

  const flushWaiters = () => {
    while (lines.length > 0 && waiters.length > 0) {
      waiters.shift()?.resolve(lines.shift() ?? "");
    }
  };

  const rejectWaiters = (error: Error) => {
    while (waiters.length > 0) waiters.shift()?.reject(error);
  };

  socket.setEncoding("utf8");
  socket.setTimeout(15000);
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      lines.push(buffer.slice(0, newlineIndex + 1).trimEnd());
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
    flushWaiters();
  });
  socket.on("timeout", () => socket.destroy(new Error("SMTP timeout")));
  socket.on("error", rejectWaiters);
  socket.on("close", () => rejectWaiters(new Error("SMTP connection closed")));

  const nextLine = () => {
    const line = lines.shift();
    if (line) return Promise.resolve(line);
    return new Promise<string>((resolve, reject) => waiters.push({ resolve, reject }));
  };

  return async () => {
    let text = "";
    let code = "";

    while (true) {
      const line = await nextLine();
      text += `${line}\n`;
      if (/^\d{3}[ -]/.test(line)) {
        code = line.slice(0, 3);
        if (line.charAt(3) === " ") return { code, text };
      }
    }
  };
};

const sendSmtpMail = async ({
  host,
  port,
  username,
  password,
  fromName,
  to,
  subject,
  replyToName,
  replyToEmail,
  text,
}: {
  host: string;
  port: number;
  username: string;
  password: string;
  fromName: string;
  to: string;
  subject: string;
  replyToName: string;
  replyToEmail: string;
  text: string;
}) => {
  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  const readResponse = readSmtpResponseFactory(socket);

  const waitForSecureConnect = new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });

  const expect = async (expectedCodes: string[], command?: string) => {
    if (command) socket.write(`${command}\r\n`);
    const response = await readResponse();
    if (!expectedCodes.includes(response.code)) {
      throw new Error(`SMTP ${command ?? "greeting"} failed: ${response.text.trim()}`);
    }
    return response;
  };

  await waitForSecureConnect;
  await expect(["220"]);
  await expect(["250"], "EHLO fass-und-flamme.de");
  await expect(["334"], "AUTH LOGIN");
  await expect(["334"], Buffer.from(username, "utf8").toString("base64"));
  await expect(["235"], Buffer.from(password, "utf8").toString("base64"));
  await expect(["250"], `MAIL FROM:<${username}>`);
  await expect(["250", "251"], `RCPT TO:<${to}>`);
  await expect(["354"], "DATA");

  const message = [
    `From: ${formatAddress(fromName, username)}`,
    `To: ${formatAddress("Rezeption", to)}`,
    `Reply-To: ${formatAddress(replyToName, replyToEmail)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(16).slice(2)}@fass-und-flamme.de>`,
    "",
    dotStuff(text),
    ".",
  ].join("\r\n");

  socket.write(`${message}\r\n`);
  await expect(["250"]);
  await expect(["221"], "QUIT").catch(() => undefined);
  socket.end();
};

export const POST: APIRoute = async ({ request }) => {
  const env = import.meta.env;
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT ?? 465);
  const username = env.SMTP_USERNAME;
  const password = env.SMTP_PASSWORD;
  const fromName = env.SMTP_FROM_NAME ?? "Fass und Flamme Web";
  const subjectPrefix = env.SMTP_SUBJECT_PREFIX ?? "Fass und Flamme Web";
  const recipient = env.CONTACT_RECIPIENT ?? username;

  if (!host || !port || !username || !password || !recipient) {
    return json({ ok: false, message: "SMTP ist noch nicht konfiguriert." }, 500);
  }

  const form = await request.formData();
  const name = clean(form.get("name"));
  const email = clean(form.get("email"), 120);
  const phone = clean(form.get("phone"), 60) || "Nicht angegeben";
  const topic = clean(form.get("topic"));
  const message = cleanMessage(form.get("message"));
  const privacy = clean(form.get("privacy"));

  if (!name || !email || !topic || !message || privacy !== "accepted") {
    return json({ ok: false, message: "Bitte füllen Sie alle Pflichtfelder aus." }, 400);
  }

  if (!isValidEmail(email)) {
    return json({ ok: false, message: "Bitte geben Sie eine gültige E-Mail-Adresse ein." }, 400);
  }

  if (!CONTACT_TOPICS.has(topic)) {
    return json({ ok: false, message: "Bitte wählen Sie einen gültigen Anlass." }, 400);
  }

  const subject = `${subjectPrefix} - ${topic}`;
  const text = [
    "Neue Anfrage über die Website von Fass & Flamme.",
    "",
    `Name: ${name}`,
    `E-Mail: ${email}`,
    `Telefon: ${phone}`,
    `Anlass: ${topic}`,
    "",
    "Nachricht:",
    message,
    "",
    "Quelle: Fass und Flamme Web Kontaktformular",
  ].join("\n");

  try {
    await sendSmtpMail({
      host,
      port,
      username,
      password,
      fromName,
      to: recipient,
      subject,
      replyToName: name,
      replyToEmail: email,
      text,
    });

    if (!wantsJson(request)) {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/kontakt/danke/",
          "cache-control": "no-store",
        },
      });
    }

    return json({ ok: true, message: "Vielen Dank. Ihre Nachricht wurde gesendet." });
  } catch (error) {
    console.error("Contact form SMTP error", error);
    return json(
      {
        ok: false,
        message: "Der Versand konnte nicht abgeschlossen werden. Bitte rufen Sie uns direkt an.",
      },
      502,
    );
  }
};
