import { createSocket } from "node:dgram";

// A catch-all DNS server. Docker's embedded DNS answers compose service names itself and forwards every other
// name here, so every outside hostname resolves to the fake-service container and no call can slip past it.

const TYPE_A = 1;

export interface Question {
  id: number;
  name: string;
  type: number;
  end: number;
}

export function parseQuery(msg: Buffer): Question | undefined {
  if (msg.length < 17) return undefined;
  const labels: string[] = [];
  let i = 12;
  while (i < msg.length && msg[i] !== 0) {
    const length = msg[i] ?? 0;
    if (length > 63 || i + 1 + length > msg.length) return undefined;
    labels.push(msg.subarray(i + 1, i + 1 + length).toString("latin1"));
    i += length + 1;
  }
  if (i + 5 > msg.length) return undefined;
  return { id: msg.readUInt16BE(0), name: labels.join(".").toLowerCase(), type: msg.readUInt16BE(i + 1), end: i + 5 };
}

/** Answers A queries with the given address and everything else with an empty, successful answer. */
export function answer(msg: Buffer, question: Question, address: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(question.id, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  const isA = question.type === TYPE_A;
  header.writeUInt16BE(isA ? 1 : 0, 6);
  const parts = [header, msg.subarray(12, question.end)];
  if (isA) {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(TYPE_A, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(5, 6);
    record.writeUInt16BE(4, 10);
    address.split(".").forEach((octet, index) => record.writeUInt8(Number(octet), 12 + index));
    parts.push(record);
  }
  return Buffer.concat(parts);
}

export function startDns(address: string, onQuery: (name: string) => void, port = 53): void {
  const socket = createSocket("udp4");
  socket.on("message", (msg, remote) => {
    const question = parseQuery(msg);
    if (!question) return;
    if (question.type === TYPE_A) onQuery(question.name);
    socket.send(answer(msg, question, address), remote.port, remote.address);
  });
  socket.bind(port);
}
