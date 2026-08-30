#!/usr/bin/env node

import {
	migratePlatformDatabase,
	platformDatabaseUrlFromEnvironment,
} from "./migrate.ts";

try {
	await migratePlatformDatabase({
		databaseUrl: platformDatabaseUrlFromEnvironment(),
	});
	process.stdout.write("Platform migrations applied\n");
} catch {
	process.stderr.write("Platform migration failed\n");
	process.exitCode = 1;
}
