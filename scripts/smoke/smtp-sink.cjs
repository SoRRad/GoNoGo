/**
 * A tiny SMTP server that accepts everything and keeps it, for tests.
 *
 * Plain text only, AUTH PLAIN only: just enough of the protocol for
 * nodemailer to hand over a message, so invitation emails can be checked end
 * to end without sending anything anywhere. Used by the unit tests and, run as
 * a script, by the container smoke test:
 *
 *   node smtp-sink.cjs <port> <file>   appends each message to <file> as JSON lines
 */
const fs = require('fs');
const net = require('net');

/** Decodes RFC 2047 encoded words, which is how a header carries anything beyond ASCII. */
function decodeWords(value) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, kind, text) =>
      kind.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(
            text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hex) => String.fromCharCode(parseInt(hex, 16))),
            'latin1',
          ).toString('utf8'),
    );
}

/** Decodes a single-part message body by its Content-Transfer-Encoding. */
function parseMessage(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  let body = raw.slice(split + 4);
  const headers = {};
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = decodeWords(line.slice(colon + 1).trim());
  }
  const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();
  if (encoding === 'quoted-printable') {
    body = Buffer.from(
      body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
      'latin1',
    ).toString('utf8');
  } else if (encoding === 'base64') {
    body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  return { headers, body: body.replace(/\r\n/g, '\n') };
}

/**
 * Starts the sink. `rejectAuth` makes it refuse every password, the way Gmail
 * does when an app password is wrong.
 */
function startSmtpSink({ port = 0, rejectAuth = false, onMessage } = {}) {
  const messages = [];
  const logins = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = [];
    let envelope = { from: null, to: [] };
    const reply = (line) => socket.write(`${line}\r\n`);
    const login = (encoded) => {
      const [, user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split('\u0000');
      logins.push({ user, pass });
      reply(rejectAuth ? '535 5.7.8 Username and Password not accepted' : '235 2.7.0 Accepted');
    };
    let awaitingAuth = false;

    reply('220 sink ESMTP ready');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const raw = Buffer.from(data.join('\r\n'), 'latin1').toString('latin1');
            const message = { ...envelope, raw, ...parseMessage(raw) };
            messages.push(message);
            if (onMessage) onMessage(message);
            envelope = { from: null, to: [] };
            data = [];
            reply('250 2.0.0 OK queued');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        if (awaitingAuth) {
          awaitingAuth = false;
          login(line.trim());
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250-sink\r\n250-AUTH PLAIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        else if (upper.startsWith('HELO')) reply('250 sink');
        else if (upper.startsWith('AUTH PLAIN')) {
          const argument = line.slice('AUTH PLAIN'.length).trim();
          if (argument) login(argument);
          else {
            awaitingAuth = true;
            reply('334 ');
          }
        } else if (upper.startsWith('MAIL FROM:')) {
          envelope.from = line.slice(10).trim().replace(/^<|>.*$/g, '');
          reply('250 2.1.0 OK');
        } else if (upper.startsWith('RCPT TO:')) {
          envelope.to.push(line.slice(8).trim().replace(/^<|>.*$/g, ''));
          reply('250 2.1.5 OK');
        } else if (upper === 'DATA') {
          inData = true;
          reply('354 Go ahead');
        } else if (upper === 'RSET' || upper === 'NOOP') reply('250 OK');
        else if (upper === 'QUIT') {
          reply('221 2.0.0 Bye');
          socket.end();
        } else reply('502 5.5.2 Not implemented');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        messages,
        logins,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startSmtpSink, parseMessage };

if (require.main === module) {
  const [port, file] = process.argv.slice(2);
  startSmtpSink({
    port: Number(port),
    onMessage: (message) =>
      fs.appendFileSync(file, JSON.stringify({ from: message.from, to: message.to, headers: message.headers, body: message.body }) + '\n'),
  }).then((sink) => console.log(`smtp sink listening on ${sink.port}`));
}
