import type { Battle } from "@/schema";

/**
 * `battleTime` is a normalized ISO 8601 timestamp (see `BattleSchema`), so lexicographic comparison
 * is equivalent to chronological order — no Date parsing needed to find the most recent one.
 */

/** The most recently played battle, or undefined if the log is empty. */
export function latestBattle(battles: Battle[]) {
	let latest: Battle | undefined;
	for (const battle of battles) {
		if (latest === undefined || battle.battleTime > latest.battleTime) latest = battle;
	}
	return latest;
}
