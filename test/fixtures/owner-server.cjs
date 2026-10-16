const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

exports.startOwnerServer = async (home, control = {}) => {
  const directory = path.join(home, 'ipc');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const endpoint = path.join(directory, 'ipc.sock');
  const messages = [], sockets = new Set();
  let discoveries = 0, connections = 0;
  const server = net.createServer(socket => {
    const ownerId = control.ownerId ?? 'fixture-owner';
    const clientId = `fixture-follower-${++connections}`;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const send = message => {
      const data = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
      header.writeUInt32LE(data.length);
      const packet = Buffer.concat([header, data]);
      if (control.splitFrames) {
        socket.write(packet.subarray(0, 2));
        socket.write(packet.subarray(2, 7));
        socket.write(packet.subarray(7));
      } else socket.write(packet);
    };
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        messages.push(message);
        if (control.disconnectBefore && message.method === control.disconnectBefore) {
          control.disconnectBefore = undefined;
          socket.destroy();
          return;
        }
        const threadId = control.threadId ?? 'owned-fixture';
        const reply = result => send({ type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: ownerId, result });
        if (message.method === 'initialize') reply({ clientId });
        else if (message.method === 'thread-owner-discovery') {
          if (control.suppressDiscovery) continue;
          if (control.stalledDiscoveries > 0) { control.stalledDiscoveries--; continue; }
          if (control.noOwner || ++discoveries <= (control.missingDiscoveries ?? 0) || message.params.conversationId !== threadId) {
            send({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' });
          } else reply({ supportsUntrustedAppInput: true });
        } else if (message.method === 'thread-stream-following-changed' && message.params.following) {
          if (control.suppressSnapshot) continue;
          send({ type: 'client-discovery-request', requestId: 'unrelated-discovery', request: { method: 'unrelated' } });
          send({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'another-owner',
            version: 11, params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', conversationState: { id: 'wrong' } } } });
          send({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: ownerId,
            targetClientIds: [clientId], version: control.version ?? 11,
            params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', conversationState: {
              id: control.wrongThread ? 'wrong' : threadId, threadRuntimeStatus: { type: control.busy ? 'active' : 'idle' },
              turns: [], turnHistory: { kind: 'canonical', history: { entitiesByKey: control.pendingTurn ? { tail: { status: 'inProgress' } } : {} } },
            } } } });
        } else if (message.method === 'thread-follower-start-turn') {
          control.onTurn?.(message);
          if (control.disconnect) socket.destroy();
          else if (control.error) send({ type: 'response', requestId: message.requestId, resultType: 'error', error: control.error });
          else reply({ result: { turn: { id: 'owner-turn', status: 'inProgress' } } });
        }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  return {
    endpoint, messages,
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
};
