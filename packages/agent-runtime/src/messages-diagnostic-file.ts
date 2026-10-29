import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

const maximumBytes = 262_144;
const unavailable = () => new Error("RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE");
type Identity = { dev: string; ino: string };
export interface MessagesDiagnosticDirectory {
	readonly root: string;
	readonly sessionRef: string;
	readonly rootIdentity: Identity;
	readonly sessionIdentity: Identity;
}
const same = (
	left: { dev: bigint | string; ino: bigint | string },
	right: Identity,
) => String(left.dev) === right.dev && String(left.ino) === right.ino;
const directoryFlags =
	constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Freeze the already admitted Session directory before its native process starts. */
export async function captureMessagesDiagnosticDirectory(
	root: string,
	sessionRef: string,
): Promise<MessagesDiagnosticDirectory> {
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
			sessionRef,
		) ||
		(await realpath(root)) !== root
	)
		throw unavailable();
	const parent = await open(root, directoryFlags);
	try {
		const rootIdentity = await parent.stat({ bigint: true });
		const directory = join(root, sessionRef);
		const session = await open(directory, directoryFlags);
		try {
			const sessionIdentity = await session.stat({ bigint: true });
			if (
				!rootIdentity.isDirectory() ||
				!sessionIdentity.isDirectory() ||
				!same(await lstat(root, { bigint: true }), {
					dev: String(rootIdentity.dev),
					ino: String(rootIdentity.ino),
				}) ||
				rootIdentity.uid !== BigInt(process.getuid?.() ?? -1) ||
				sessionIdentity.uid !== BigInt(process.getuid?.() ?? -1) ||
				(rootIdentity.mode & 0o022n) !== 0n ||
				(sessionIdentity.mode & 0o022n) !== 0n ||
				(await realpath(directory)) !== directory
			)
				throw unavailable();
			return {
				root,
				sessionRef,
				rootIdentity: {
					dev: String(rootIdentity.dev),
					ino: String(rootIdentity.ino),
				},
				sessionIdentity: {
					dev: String(sessionIdentity.dev),
					ino: String(sessionIdentity.ino),
				},
			};
		} finally {
			await session.close();
		}
	} finally {
		await parent.close();
	}
}

// This fixed child changes only its own cwd. Inherited FD identities reject replacement
// before chdir; afterwards relative I/O stays anchored even if any parent is renamed.
const childProgram = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
const C=fs.constants,limit=262144,leaf='messages-diagnostics.json';
const same=(a,b)=>String(a.dev)===String(b.dev)&&String(a.ino)===String(b.ino);
const fail=()=>{throw Error('DIAGNOSTIC_IO_REJECTED')};
const dir=s=>s.isDirectory()&&s.uid===BigInt(process.getuid())&&(s.mode&0o022n)===0n;
const file=s=>s.isFile()&&s.uid===BigInt(process.getuid())&&(s.mode&0o777n)===0o600n&&s.nlink===1n;
const input=[];let size=0;
process.stdin.on('data',part=>{size+=part.length;if(size>limit+1){process.exit(1)}input.push(part)});
process.stdin.on('end',()=>{let directory,handle,tmp;
try{
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(input)));if(!/^[a-f0-9-]{36}$/.test(value.sessionRef)||!['read','write'].includes(value.operation))fail();
 const root=fs.fstatSync(3,{bigint:true});if(!dir(root)||!same(root,value.rootIdentity)||!same(root,fs.statSync('.',{bigint:true})))fail();
 directory=fs.openSync(value.sessionRef,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);const expected=fs.fstatSync(directory,{bigint:true});
 if(!dir(expected)||!same(expected,value.sessionIdentity))fail();process.chdir(value.sessionRef);if(!same(expected,fs.statSync('.',{bigint:true})))fail();
 if(value.operation==='read'){
  try{handle=fs.openSync(leaf,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK)}catch(e){if(e.code==='ENOENT'){process.stdout.write('-');return}throw e}
  const before=fs.fstatSync(handle,{bigint:true});if(!file(before)||before.size>BigInt(limit))fail();const bytes=Buffer.alloc(limit+1);let count=0;
  while(count<=limit){const n=fs.readSync(handle,bytes,count,bytes.length-count,count);if(!n)break;count+=n;if(count>limit)fail()}
  const after=fs.fstatSync(handle,{bigint:true});if(!file(after)||!same(before,after)||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(count)!==after.size)fail();
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count));JSON.parse(text);process.stdout.write(text);
 }else{
  if(typeof value.serialized!=='string'||Buffer.byteLength(value.serialized)>limit)fail();JSON.parse(value.serialized);
  tmp='.'+leaf+'.'+crypto.randomUUID()+'.tmp';handle=fs.openSync(tmp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW|C.O_NONBLOCK,0o600);if(!file(fs.fstatSync(handle,{bigint:true})))fail();
  fs.writeFileSync(handle,value.serialized);fs.fsyncSync(handle);fs.closeSync(handle);handle=undefined;fs.renameSync(tmp,leaf);tmp=undefined;fs.fsyncSync(directory);process.stdout.write('-');
 }
}catch{process.exitCode=1}finally{if(handle!==undefined)try{fs.closeSync(handle)}catch{};if(tmp)try{fs.unlinkSync(tmp)}catch{};if(directory!==undefined)try{fs.closeSync(directory)}catch{}}
});
`;

async function operation(
	directory: MessagesDiagnosticDirectory,
	method: "read" | "write",
	serialized?: string,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const root = await open(directory.root, directoryFlags);
	try {
		signal?.throwIfAborted();
		if (!same(await root.stat({ bigint: true }), directory.rootIdentity))
			throw unavailable();
		signal?.throwIfAborted();
		const input = JSON.stringify({
			...directory,
			root: undefined,
			operation: method,
			...(serialized === undefined ? {} : { serialized }),
		});
		if (Buffer.byteLength(input) > maximumBytes + 1) throw unavailable();
		return await new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ["-e", childProgram], {
				cwd: directory.root,
				env: {},
				stdio: ["pipe", "pipe", "ignore", root.fd],
				shell: false,
			});
			const inputStream = child.stdin;
			const outputStream = child.stdout;
			if (!inputStream || !outputStream) {
				child.kill("SIGKILL");
				child.once("close", () => reject(unavailable()));
				return;
			}
			const output: Buffer[] = [];
			let bytes = 0;
			let failed = false;
			const stop = () => {
				failed = true;
				child.kill("SIGKILL");
			};
			signal?.addEventListener("abort", stop, { once: true });
			// Diagnostic I/O is best effort and detached; this only bounds its owned child.
			const timer = setTimeout(stop, 5000);
			outputStream.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > maximumBytes + 1) stop();
				else output.push(chunk);
			});
			inputStream.on("error", stop);
			child.once("error", () => {
				failed = true;
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
				if (failed || code !== 0) reject(unavailable());
				else {
					try {
						resolve(
							new TextDecoder("utf-8", { fatal: true }).decode(
								Buffer.concat(output),
							),
						);
					} catch {
						reject(unavailable());
					}
				}
			});
			if (signal?.aborted) stop();
			else inputStream.end(input);
		});
	} finally {
		await root.close();
	}
}

/** Private bounded diagnostics only; never used for authoritative Runtime state. */
export class MessagesDiagnosticFile<T> {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private poisoned = false;
	private constructor(
		private readonly directory: MessagesDiagnosticDirectory,
		private state: T,
		private readonly controller: AbortController,
		private readonly signal: AbortSignal,
	) {}
	static async open<T>(
		directory: MessagesDiagnosticDirectory,
		initial: T,
		parentSignal?: AbortSignal,
	) {
		const controller = new AbortController();
		const signal = parentSignal
			? AbortSignal.any([controller.signal, parentSignal])
			: controller.signal;
		const result = await operation(directory, "read", undefined, signal);
		return new MessagesDiagnosticFile(
			directory,
			result === "-" ? structuredClone(initial) : (JSON.parse(result) as T),
			controller,
			signal,
		);
	}
	read() {
		if (this.poisoned) throw unavailable();
		return structuredClone(this.state);
	}
	update(change: (draft: T) => void) {
		if (this.closed) return Promise.reject(unavailable());
		const pending = this.queue.then(async () => {
			if (this.closed) return;
			this.signal.throwIfAborted();
			if (this.poisoned) throw unavailable();
			const draft = structuredClone(this.state);
			change(draft);
			const serialized = JSON.stringify(draft) + "\n";
			if (Buffer.byteLength(serialized) > maximumBytes) throw unavailable();
			try {
				await this.persist(serialized);
			} catch {
				this.poisoned = true;
				throw unavailable();
			}
			this.state = draft;
		});
		this.queue = pending.catch(() => {});
		return pending;
	}
	private async persist(serialized: string) {
		await operation(this.directory, "write", serialized, this.signal);
	}
	close() {
		this.closed = true;
		this.controller.abort();
		return this.queue;
	}
}
