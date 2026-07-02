// Minimal ambient declarations for the Deno runtime APIs this project uses, so the oxlint/tsgolint
// type-aware pass (vanilla TypeScript, not Deno) can resolve `Deno.*`. Excluded from `deno check`
// and `deno lint` via deno.json so it never clashes with Deno's own built-in lib types.

declare namespace Deno {
	export const env: {
		get(key: string): string | undefined;
	};

	export function cron(name: string, schedule: string, handler: () => void | Promise<void>): void;

	export type KvEntry<T> = {
		key: readonly unknown[];
		value: T;
		versionstamp: string;
	};

	export type KvEntryMaybe<T> =
		| KvEntry<T>
		| {
				key: readonly unknown[];
				value: null;
				versionstamp: null;
		  };

	export type KvCommitResult = {
		ok: true;
		versionstamp: string;
	};

	export type Kv = {
		get<T = unknown>(key: readonly unknown[]): Promise<KvEntryMaybe<T>>;
		set(key: readonly unknown[], value: unknown): Promise<KvCommitResult>;
		list<T = unknown>(selector: { prefix: readonly unknown[] }): AsyncIterableIterator<KvEntry<T>>;
	};

	export function openKv(path?: string): Promise<Kv>;
}
