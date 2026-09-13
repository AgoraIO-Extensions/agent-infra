export function createCredentialMatcher(credentials: readonly string[]) {
	const firstEdges = [-1];
	const failures = [0];
	const terminal = [false];
	const edgeCharacters: string[] = [];
	const edgeTargets: number[] = [];
	const nextEdges: number[] = [];
	const indexedTransitions = new Map<number, ReadonlyMap<string, number>>();
	const transition = (state: number, character: string) => {
		const indexed = indexedTransitions.get(state);
		if (indexed) return indexed.get(character);
		for (
			let edge = firstEdges[state] ?? -1;
			edge >= 0;
			edge = nextEdges[edge] ?? -1
		) {
			if (edgeCharacters[edge] === character) return edgeTargets[edge];
		}
	};
	for (const credential of credentials) {
		let state = 0;
		for (const character of credential) {
			let target = transition(state, character);
			if (target === undefined) {
				target = firstEdges.length;
				firstEdges.push(-1);
				failures.push(0);
				terminal.push(false);
				const edge = edgeCharacters.length;
				edgeCharacters.push(character);
				edgeTargets.push(target);
				nextEdges.push(firstEdges[state] ?? -1);
				firstEdges[state] = edge;
			}
			state = target;
		}
		terminal[state] = true;
	}
	for (let state = 0; state < firstEdges.length; state += 1) {
		const entries: [string, number][] = [];
		for (
			let edge = firstEdges[state] ?? -1;
			edge >= 0;
			edge = nextEdges[edge] ?? -1
		) {
			const character = edgeCharacters[edge];
			const target = edgeTargets[edge];
			if (character !== undefined && target !== undefined)
				entries.push([character, target]);
		}
		if (entries.length > 4) indexedTransitions.set(state, new Map(entries));
	}
	const queue: number[] = [];
	for (
		let edge = firstEdges[0] ?? -1;
		edge >= 0;
		edge = nextEdges[edge] ?? -1
	) {
		const target = edgeTargets[edge];
		if (target !== undefined) queue.push(target);
	}
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const state = queue[cursor];
		if (state === undefined) continue;
		for (
			let edge = firstEdges[state] ?? -1;
			edge >= 0;
			edge = nextEdges[edge] ?? -1
		) {
			const character = edgeCharacters[edge];
			const target = edgeTargets[edge];
			if (character === undefined || target === undefined) continue;
			let fallback = failures[state] ?? 0;
			let candidate = transition(fallback, character);
			while (fallback > 0 && candidate === undefined) {
				fallback = failures[fallback] ?? 0;
				candidate = transition(fallback, character);
			}
			failures[target] = candidate ?? 0;
			terminal[target] =
				terminal[target] === true || terminal[failures[target] ?? 0] === true;
			queue.push(target);
		}
	}
	const advance = (initialState: number, value: string) => {
		let state = initialState;
		for (const character of value) {
			let target = transition(state, character);
			while (state > 0 && target === undefined) {
				state = failures[state] ?? 0;
				target = transition(state, character);
			}
			state = target ?? 0;
			if (terminal[state]) return { matched: true, state };
		}
		return { matched: false, state };
	};
	return {
		advance,
		contains: (value: string) => advance(0, value).matched,
	};
}
