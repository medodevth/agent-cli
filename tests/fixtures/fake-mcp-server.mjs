#!/usr/bin/env node
/**
 * A minimal MCP server over stdio, used by the tests.
 *
 * Speaks just enough of the protocol to exercise the client: initialize,
 * tools/list, tools/call. It also prints a banner on stderr and a non-JSON line
 * on stdout, because real servers do and the client must ignore both.
 */
let buffer = '';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
    index = buffer.indexOf('\n');
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo the text back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
          {
            name: 'fail',
            description: 'Always reports an error',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + String(args.text) }] } });
      return;
    }
    if (name === 'fail') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'tool exploded' }], isError: true } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool ' + String(name) } });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
}

process.stderr.write('fake-mcp: banner line that is not JSON\n');
process.stdout.write('not-json-banner\n');
