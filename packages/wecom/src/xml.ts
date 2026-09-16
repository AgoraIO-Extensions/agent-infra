import { SaxesParser } from "saxes";

/** WeCom's flat XML envelope; DTDs, nested fields and duplicate elements are rejected. */
export function parseWecomXml(xml: string): Record<string, string> {
	const result: Record<string, string> = Object.create(null);
	let depth = 0;
	let key = "";
	let root = false;
	const parser = new SaxesParser({ xmlns: false });
	parser.on("doctype", () => {
		throw new Error("Invalid XML");
	});
	parser.on("opentag", (tag) => {
		depth++;
		if (Object.keys(tag.attributes).length || depth > 2)
			throw new Error("Invalid XML");
		if (depth === 1) {
			if (root || tag.name !== "xml") throw new Error("Invalid XML");
			root = true;
		} else {
			key = tag.name;
			if (Object.hasOwn(result, key)) throw new Error("Invalid XML");
			result[key] = "";
		}
	});
	const append = (value: string) => {
		if (depth === 2) result[key] += value;
		else if (value.trim()) throw new Error("Invalid XML");
	};
	parser.on("text", append);
	parser.on("cdata", append);
	parser.on("closetag", () => {
		depth--;
	});
	parser.write(xml).close();
	if (!root) throw new Error("Invalid XML");
	return result;
}
