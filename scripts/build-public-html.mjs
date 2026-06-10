import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const target = join(root, "dist-public_html");
const privateTarget = join(root, "dist-private");
const apiRoute = join(root, "src/pages/api/contact.ts");
const disabledApiRoute = join(root, "src/pages/api/contact.ts.static-disabled");

const parseEnv = (value) => {
  const env = {};

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let rawValue = line.slice(separatorIndex + 1).trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }
    env[key] = rawValue;
  }

  return env;
};

const escapePhp = (value = "") => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const runStaticBuild = () =>
  new Promise((resolveBuild, rejectBuild) => {
    const child = spawn("npm", ["run", "build:static"], {
      cwd: root,
      env: {
        ...process.env,
        PUBLIC_CONTACT_ENDPOINT: "/contact.php",
      },
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Static build failed with exit code ${code}`));
    });
  });

const build = async () => {
  const shouldDisableApi = existsSync(apiRoute);

  try {
    if (shouldDisableApi) await rename(apiRoute, disabledApiRoute);
    await runStaticBuild();
  } finally {
    if (shouldDisableApi && existsSync(disabledApiRoute)) await rename(disabledApiRoute, apiRoute);
  }
};

const copyDirectory = async (from, to) => {
  await rm(to, { force: true, recursive: true });
  await mkdir(to, { recursive: true });
  await spawnCopy(from, to);
};

const spawnCopy = (from, to) =>
  new Promise((resolveCopy, rejectCopy) => {
    const child = spawn("cp", ["-R", `${from}/.`, to], {
      cwd: root,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) resolveCopy();
      else rejectCopy(new Error(`Copy failed with exit code ${code}`));
    });
  });

const makeContactConfigPhp = (env) => `<?php
declare(strict_types=1);

return [
    'smtpHost' => '${escapePhp(env.SMTP_HOST || "mail.privateemail.com")}',
    'smtpPort' => ${Number(env.SMTP_PORT || 465)},
    'smtpUsername' => '${escapePhp(env.SMTP_USERNAME || "info@hotel-weisses-haus.com")}',
    'smtpPassword' => '${escapePhp(env.SMTP_PASSWORD || "")}',
    'smtpFromName' => '${escapePhp(env.SMTP_FROM_NAME || "Fass und Flamme Web")}',
    'recipient' => '${escapePhp(env.CONTACT_RECIPIENT || env.SMTP_USERNAME || "info@hotel-weisses-haus.com")}',
    'subjectPrefix' => '${escapePhp(env.SMTP_SUBJECT_PREFIX || "Fass und Flamme Web")}',
];
`;

const makeContactPhp = () => `<?php
declare(strict_types=1);

$configPath = __DIR__ . '/../private/contact-config.php';
$config = is_file($configPath) ? require $configPath : [];

$smtpHost = (string)($config['smtpHost'] ?? 'mail.privateemail.com');
$smtpPort = (int)($config['smtpPort'] ?? 465);
$smtpUsername = (string)($config['smtpUsername'] ?? '');
$smtpPassword = (string)($config['smtpPassword'] ?? '');
$smtpFromName = (string)($config['smtpFromName'] ?? 'Fass und Flamme Web');
$recipient = (string)($config['recipient'] ?? $smtpUsername);
$subjectPrefix = (string)($config['subjectPrefix'] ?? 'Fass und Flamme Web');

function json_response(array $body, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

function wants_json(): bool {
    return strpos($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json') !== false;
}

function utf8_limit(string $value, int $max): string {
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $max, 'UTF-8');
    }

    return substr($value, 0, $max);
}

function clean_field(string $key, int $max = 160): string {
    $value = trim((string)($_POST[$key] ?? ''));
    $value = preg_replace('/\\s+/u', ' ', $value) ?? '';
    return utf8_limit($value, $max);
}

function clean_message(string $key, int $max = 1600): string {
    $value = trim((string)($_POST[$key] ?? ''));
    $value = str_replace(["\\r\\n", "\\r"], "\\n", $value);
    return utf8_limit($value, $max);
}

function encode_header_value(string $value): string {
    $value = preg_replace('/[\\r\\n]+/', ' ', $value) ?? '';
    return '=?UTF-8?B?' . base64_encode($value) . '?=';
}

function format_address(string $name, string $email): string {
    return encode_header_value($name) . ' <' . $email . '>';
}

function smtp_read($socket): array {
    $text = '';
    $code = '';

    while (($line = fgets($socket, 515)) !== false) {
        $text .= $line;
        if (preg_match('/^(\\d{3})([ -])/', $line, $matches)) {
            $code = $matches[1];
            if ($matches[2] === ' ') {
                return [$code, $text];
            }
        }
    }

    throw new RuntimeException('SMTP connection closed');
}

function smtp_expect($socket, array $expected, ?string $command = null): void {
    if ($command !== null) {
        fwrite($socket, $command . "\\r\\n");
    }

    [$code, $text] = smtp_read($socket);
    if (!in_array($code, $expected, true)) {
        throw new RuntimeException('SMTP error: ' . trim($text));
    }
}

function dot_stuff(string $value): string {
    $value = str_replace(["\\r\\n", "\\r"], "\\n", $value);
    $value = preg_replace('/\\n\\./', "\\n..", $value) ?? $value;
    return str_replace("\\n", "\\r\\n", $value);
}

function send_smtp_mail(
    string $host,
    int $port,
    string $username,
    string $password,
    string $fromName,
    string $to,
    string $subject,
    string $replyToName,
    string $replyToEmail,
    string $text
): void {
    $socket = stream_socket_client('ssl://' . $host . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT);

    if (!$socket) {
        throw new RuntimeException('SMTP connect failed: ' . $errstr);
    }

    stream_set_timeout($socket, 15);
    smtp_expect($socket, ['220']);
    smtp_expect($socket, ['250'], 'EHLO fassflamme.de');
    smtp_expect($socket, ['334'], 'AUTH LOGIN');
    smtp_expect($socket, ['334'], base64_encode($username));
    smtp_expect($socket, ['235'], base64_encode($password));
    smtp_expect($socket, ['250'], 'MAIL FROM:<' . $username . '>');
    smtp_expect($socket, ['250', '251'], 'RCPT TO:<' . $to . '>');
    smtp_expect($socket, ['354'], 'DATA');

    $headers = [
        'From: ' . format_address($fromName, $username),
        'To: ' . format_address('Rezeption', $to),
        'Reply-To: ' . format_address($replyToName, $replyToEmail),
        'Subject: ' . encode_header_value($subject),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
        'Message-ID: <' . time() . '.' . bin2hex(random_bytes(8)) . '@fassflamme.de>',
    ];

    fwrite($socket, implode("\\r\\n", $headers) . "\\r\\n\\r\\n" . dot_stuff($text) . "\\r\\n.\\r\\n");
    smtp_expect($socket, ['250']);
    try {
        smtp_expect($socket, ['221'], 'QUIT');
    } catch (Throwable $error) {
    }
    fclose($socket);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Location: /kontakt/');
    exit;
}

$topics = ['Reservierung', 'Gruppenabend', 'Feedback', 'Allgemeine Anfrage'];
$name = clean_field('name');
$email = clean_field('email', 120);
$phone = clean_field('phone', 60) ?: 'Nicht angegeben';
$topic = clean_field('topic');
$message = clean_message('message');
$privacy = clean_field('privacy');

if ($name === '' || $email === '' || $topic === '' || $message === '' || $privacy !== 'accepted') {
    json_response(['ok' => false, 'message' => 'Bitte füllen Sie alle Pflichtfelder aus.'], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_response(['ok' => false, 'message' => 'Bitte geben Sie eine gültige E-Mail-Adresse ein.'], 400);
}

if (!in_array($topic, $topics, true)) {
    json_response(['ok' => false, 'message' => 'Bitte wählen Sie einen gültigen Anlass.'], 400);
}

if (!is_file($configPath)) {
    error_log('Fass und Flamme contact form config missing: ' . $configPath);
    json_response(['ok' => false, 'message' => 'Der Versand ist noch nicht konfiguriert.'], 500);
}

if ($smtpUsername === '' || $smtpPassword === '' || $recipient === '') {
    error_log('Fass und Flamme contact form config incomplete.');
    json_response(['ok' => false, 'message' => 'SMTP ist noch nicht konfiguriert.'], 500);
}

$body = implode("\\n", [
    'Neue Anfrage über die Website von Fass & Flamme.',
    '',
    'Name: ' . $name,
    'E-Mail: ' . $email,
    'Telefon: ' . $phone,
    'Anlass: ' . $topic,
    '',
    'Nachricht:',
    $message,
    '',
    'Quelle: Fass und Flamme Web Kontaktformular',
]);

try {
    send_smtp_mail($smtpHost, $smtpPort, $smtpUsername, $smtpPassword, $smtpFromName, $recipient, $subjectPrefix . ' - ' . $topic, $name, $email, $body);

    if (!wants_json()) {
        header('Location: /kontakt/danke/', true, 303);
        exit;
    }

    json_response(['ok' => true, 'message' => 'Vielen Dank. Ihre Nachricht wurde gesendet.']);
} catch (Throwable $error) {
    error_log('Fass und Flamme contact form error: ' . $error->getMessage());
    json_response(['ok' => false, 'message' => 'Der Versand konnte nicht abgeschlossen werden. Bitte rufen Sie uns direkt an.'], 502);
}
`;

if (!existsSync(join(root, ".env"))) {
  throw new Error("Missing .env. It is needed to generate contact.php for public_html deployment.");
}

const env = parseEnv(await readFile(join(root, ".env"), "utf8"));
await build();
await copyDirectory(dist, target);
await rm(privateTarget, { force: true, recursive: true });
await mkdir(privateTarget, { recursive: true });
await writeFile(join(target, "contact.php"), makeContactPhp(), { mode: 0o644 });
await writeFile(join(privateTarget, "contact-config.php"), makeContactConfigPhp(env), { mode: 0o600 });

console.log("");
console.log(`public_html upload folder is ready: ${target}`);
console.log("Upload the contents of this folder into /home/admin/web/fassflamme.de/public_html");
console.log(`private config is ready: ${privateTarget}/contact-config.php`);
console.log("Upload contact-config.php into /home/admin/web/fassflamme.de/private");
