// Copy this file outside the repository as configuration.mjs and replace the
// placeholders with reviewed deployment code. This module is mounted only in
// the Worker Pod; never put its private files into an image or API Secret.

const missing = (name) => {
	throw new Error(`Configure Worker export: ${name}`);
};

export const directory = missing("directory");
export const signing = missing("signing");
export const serviceToken = missing("serviceToken");
export const workloadInput = missing("workloadInput");
