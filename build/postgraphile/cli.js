#!/usr/bin/env node
"use strict";
// tslint:disable no-console
Object.defineProperty(exports, "__esModule", { value: true });
/*
 * IMPORTANT: the './postgraphilerc' import MUST come first!
 *
 * Reason: enables user to apply modifications to their Node.js environment
 * (e.g. sourcing modules that affect global state, like dotenv) before any of
 * our other require()s occur.
 */
const postgraphilerc_1 = require("./postgraphilerc");
const http_1 = require("http");
const chalk_1 = require("chalk");
const program = require("commander");
const pg_connection_string_1 = require("pg-connection-string");
const postgraphile_1 = require("./postgraphile");
const pg_1 = require("pg");
const cluster = require("cluster");
const pluginHook_1 = require("./pluginHook");
const debugFactory = require("debug");
const manifest = require("../../package.json");
const sponsors = require("../../sponsors.json");
const subscriptions_1 = require("./http/subscriptions");
const isDev = process.env.POSTGRAPHILE_ENV === 'development';
// tslint:disable-next-line no-any
function isString(str) {
    return typeof str === 'string';
}
const sponsor = sponsors[Math.floor(sponsors.length * Math.random())];
const debugCli = debugFactory('postgraphile:cli');
// TODO: Demo Postgres database
const DEMO_PG_URL = null;
function extractPlugins(rawArgv) {
    let argv;
    let pluginStrings = [];
    if (rawArgv[2] === '--plugins') {
        pluginStrings = rawArgv[3].split(',');
        argv = [...rawArgv.slice(0, 2), ...rawArgv.slice(4)];
    }
    else {
        pluginStrings = (postgraphilerc_1.default && postgraphilerc_1.default['options'] && postgraphilerc_1.default['options']['plugins']) || [];
        argv = rawArgv;
    }
    const plugins = pluginStrings.map((pluginString) => {
        debugCli('Loading plugin %s', pluginString);
        const rawPlugin = require(pluginString); // tslint:disable-lin no-var-requires
        if (rawPlugin['default'] && typeof rawPlugin['default'] === 'object') {
            return rawPlugin['default'];
        }
        else {
            return rawPlugin;
        }
    });
    return { argv, plugins };
}
const { argv: argvSansPlugins, plugins: extractedPlugins } = extractPlugins(process.argv);
const pluginHook = pluginHook_1.makePluginHook(extractedPlugins);
program
    .version(manifest.version)
    .usage('[options...]')
    .description(manifest.description);
function addFlag(optionString, description, parse) {
    program.option(optionString, description, parse);
    return addFlag;
}
// Standard options
program
    .option('--plugins <string>', 'a list of PostGraphile server plugins (not Graphile Engine schema plugins) to load; if present, must be the _first_ option')
    .option('-c, --connection <string>', "the PostgreSQL database name or connection string. If omitted, inferred from environmental variables (see https://www.postgresql.org/docs/current/static/libpq-envars.html). Examples: 'db', 'postgres:///db', 'postgres://user:password@domain:port/db?ssl=1'")
    .option('-C, --owner-connection <string>', 'as `--connection`, but for a privileged user (e.g. for setting up watch fixtures, logical decoding, etc); defaults to the value from `--connection`')
    .option('-s, --schema <string>', 'a Postgres schema to be introspected. Use commas to define multiple schemas', (option) => option.split(','))
    .option('-S, --subscriptions', 'Enable GraphQL websocket transport support for subscriptions (you still need a subscriptions plugin currently)')
    .option('-L, --live', '[EXPERIMENTAL] Enables live-query support via GraphQL subscriptions (sends updated payload any time nested collections/records change). Implies --subscriptions')
    .option('-w, --watch', 'automatically updates your GraphQL schema when your database schema changes (NOTE: requires DB superuser to install `postgraphile_watch` schema)')
    .option('-n, --host <string>', 'the hostname to be used. Defaults to `localhost`')
    .option('-p, --port <number>', 'the port to be used. Defaults to 5000', parseFloat)
    .option('-m, --max-pool-size <number>', 'the maximum number of clients to keep in the Postgres pool. defaults to 10', parseFloat)
    .option('-r, --default-role <string>', 'the default Postgres role to use when a request is made. supercedes the role used to connect to the database')
    .option('--retry-on-init-fail', 'if an error occurs building the initial schema, this flag will cause PostGraphile to keep trying to build the schema with exponential backoff rather than exiting');
pluginHook('cli:flags:add:standard', addFlag);
// Schema configuration
program
    .option('-j, --dynamic-json', '[RECOMMENDED] enable dynamic JSON in GraphQL inputs and outputs. PostGraphile uses stringified JSON by default')
    .option('-N, --no-setof-functions-contain-nulls', '[RECOMMENDED] if none of your `RETURNS SETOF compound_type` functions mix NULLs with the results then you may enable this to reduce the nullables in the GraphQL schema')
    .option('-a, --classic-ids', 'use classic global id field name. required to support Relay 1')
    .option('-M, --disable-default-mutations', 'disable default mutations, mutation will only be possible through Postgres functions')
    .option('--simple-collections [omit|both|only]', '"omit" (default) - relay connections only, "only" - simple collections only (no Relay connections), "both" - both')
    .option('--no-ignore-rbac', '[RECOMMENDED] set this to exclude fields, queries and mutations that are not available to any possible user (determined from the user in connection string and any role they can become); this will be enabled by default in v5')
    .option('--no-ignore-indexes', '[RECOMMENDED] set this to exclude filters, orderBy, and relations that would be expensive to access due to missing indexes')
    .option('--include-extension-resources', 'by default, tables and functions that come from extensions are excluded; use this flag to include them (not recommended)');
pluginHook('cli:flags:add:schema', addFlag);
// Error enhancements
program
    .option('--show-error-stack', 'show JavaScript error stacks in the GraphQL result errors (recommended in development)')
    .option('--extended-errors <string>', "a comma separated list of extended Postgres error fields to display in the GraphQL result. Recommended in development: 'hint,detail,errcode'. Default: none", (option) => option.split(',').filter(_ => _));
pluginHook('cli:flags:add:errorHandling', addFlag);
// Plugin-related options
program
    .option('--append-plugins <string>', 'a comma-separated list of plugins to append to the list of Graphile Engine schema plugins')
    .option('--prepend-plugins <string>', 'a comma-separated list of plugins to prepend to the list of Graphile Engine schema plugins')
    .option('--skip-plugins <string>', 'a comma-separated list of Graphile Engine schema plugins to skip');
pluginHook('cli:flags:add:plugins', addFlag);
// Things that relate to -X
program
    .option('--read-cache <path>', '[experimental] reads cached values from local cache file to improve startup time (you may want to do this in production)')
    .option('--write-cache <path>', '[experimental] writes computed values to local cache file so startup can be faster (do this during the build phase)')
    .option('--export-schema-json <path>', 'enables exporting the detected schema, in JSON format, to the given location. The directories must exist already, if the file exists it will be overwritten.')
    .option('--export-schema-graphql <path>', 'enables exporting the detected schema, in GraphQL schema format, to the given location. The directories must exist already, if the file exists it will be overwritten.')
    .option('--sort-export', 'lexicographically (alphabetically) sort exported schema for more stable diffing.')
    .option('-X, --no-server', '[experimental] for when you just want to use --write-cache or --export-schema-* and not actually run a server (e.g. CI)');
pluginHook('cli:flags:add:noServer', addFlag);
// Webserver configuration
program
    .option('-q, --graphql <path>', 'the route to mount the GraphQL server on. defaults to `/graphql`')
    .option('-i, --graphiql <path>', 'the route to mount the GraphiQL interface on. defaults to `/graphiql`')
    .option('--enhance-graphiql', '[DEVELOPMENT] opt in to additional GraphiQL functionality (this may change over time - only intended for use in development; automatically enables with `subscriptions` and `live`)')
    .option('--graphiql-authorization-event-origin <string>', 'specifies the URI of a window that is allowed to use window.postMessage to update the Authorization header value GraphiQL uses to make GraphQL requests.')
    .option('-b, --disable-graphiql', 'disables the GraphiQL interface. overrides the GraphiQL route option')
    .option('-o, --cors', 'enable generous CORS settings; disabled by default, if possible use a proxy instead')
    .option('-l, --body-size-limit <string>', "set the maximum size of the HTTP request body that can be parsed (default 100kB). The size can be given as a human-readable string, such as '200kB' or '5MB' (case insensitive).")
    .option('--timeout <number>', 'set the timeout value in milliseconds for sockets', parseFloat)
    .option('--cluster-workers <count>', '[experimental] spawn <count> workers to increase throughput', parseFloat)
    .option('--enable-query-batching', '[experimental] enable the server to process multiple GraphQL queries in one request')
    .option('--disable-query-log', 'disable logging queries to console (recommended in production)');
pluginHook('cli:flags:add:webserver', addFlag);
// JWT-related options
program
    .option('-e, --jwt-secret <string>', 'the secret to be used when creating and verifying JWTs. if none is provided auth will be disabled')
    .option('--jwt-verify-algorithms <string>', 'a comma separated list of the names of the allowed jwt token algorithms', (option) => option.split(','))
    .option('-A, --jwt-verify-audience <string>', "a comma separated list of JWT audiences that will be accepted; defaults to 'postgraphile'. To disable audience verification, set to ''.", (option) => option.split(',').filter(_ => _))
    .option('--jwt-verify-clock-tolerance <number>', 'number of seconds to tolerate when checking the nbf and exp claims, to deal with small clock differences among different servers', parseFloat)
    .option('--jwt-verify-id <string>', 'the name of the allowed jwt token id')
    .option('--jwt-verify-ignore-expiration', 'if `true` do not validate the expiration of the token defaults to `false`')
    .option('--jwt-verify-ignore-not-before', 'if `true` do not validate the notBefore of the token defaults to `false`')
    .option('--jwt-verify-issuer <string>', 'a comma separated list of the names of the allowed jwt token issuer', (option) => option.split(','))
    .option('--jwt-verify-subject <string>', 'the name of the allowed jwt token subject')
    .option('--jwt-role <string>', 'a comma seperated list of strings that create a path in the jwt from which to extract the postgres role. if none is provided it will use the key `role` on the root of the jwt.', (option) => option.split(','))
    .option('-t, --jwt-token-identifier <identifier>', 'the Postgres identifier for a composite type that will be used to create JWT tokens');
pluginHook('cli:flags:add:jwt', addFlag);
// Any other options
pluginHook('cli:flags:add', addFlag);
// Deprecated
program
    .option('--token <identifier>', '[DEPRECATED] Use --jwt-token-identifier instead. This option will be removed in v5.')
    .option('--secret <string>', '[DEPRECATED] Use --jwt-secret instead. This option will be removed in v5.')
    .option('--jwt-audiences <string>', '[DEPRECATED] Use --jwt-verify-audience instead. This option will be removed in v5.', (option) => option.split(','))
    .option('--legacy-functions-only', '[DEPRECATED] PostGraphile 4.1.0 introduced support for PostgreSQL functions than declare parameters with IN/OUT/INOUT or declare RETURNS TABLE(...); enable this flag to ignore these types of functions. This option will be removed in v5.');
pluginHook('cli:flags:add:deprecated', addFlag);
// Awkward application workarounds / legacy support
program
    .option('--legacy-relations <omit|deprecated|only>', "some one-to-one relations were previously detected as one-to-many - should we export 'only' the old relation shapes, both new and old but mark the old ones as 'deprecated', or 'omit' the old relation shapes entirely")
    .option('--legacy-json-uuid', `ONLY use this option if you require the v3 typenames 'Json' and 'Uuid' over 'JSON' and 'UUID'`);
pluginHook('cli:flags:add:workarounds', addFlag);
program.on('--help', () => {
    console.log(`
Get started:

  $ postgraphile
  $ postgraphile -c postgres://localhost/my_db
  $ postgraphile --connection postgres://user:pass@localhost/my_db --schema my_schema --watch --dynamic-json
`);
    process.exit(0);
});
program.parse(argvSansPlugins);
if (program['plugins']) {
    throw new Error(`--plugins must be the first argument to postgraphile if specified`);
}
// Kill server on exit.
process.on('SIGINT', () => {
    process.exit(1);
});
// For `--no-*` options, `program` automatically contains the default,
// overriding our options. We typically want the CLI to "win", but not
// with defaults! So this code extracts those `--no-*` values and
// re-overwrites the values if necessary.
const configOptions = postgraphilerc_1.default['options'] || {};
const overridesFromOptions = {};
['ignoreIndexes', 'ignoreRbac', 'setofFunctionsContainNulls'].forEach(option => {
    if (option in configOptions) {
        overridesFromOptions[option] = configOptions[option];
    }
});
// Destruct our configuration file and command line arguments, use defaults, and rename options to
// something appropriate for JavaScript.
const { demo: isDemo = false, connection: pgConnectionString, ownerConnection, subscriptions, live, watch: watchPg, schema: dbSchema, host: hostname = 'localhost', port = 5000, timeout: serverTimeout, maxPoolSize, defaultRole: pgDefaultRole, retryOnInitFail, graphql: graphqlRoute = '/graphql', graphiql: graphiqlRoute = '/graphiql', enhanceGraphiql = false, graphiqlAuthorizationEventOrigin = null, disableGraphiql = false, secret: deprecatedJwtSecret, jwtSecret, jwtAudiences, jwtVerifyAlgorithms, jwtVerifyAudience, jwtVerifyClockTolerance, jwtVerifyId, jwtVerifyIgnoreExpiration, jwtVerifyIgnoreNotBefore, jwtVerifyIssuer, jwtVerifySubject, jwtRole = ['role'], token: deprecatedJwtPgTypeIdentifier, jwtTokenIdentifier: jwtPgTypeIdentifier, cors: enableCors = false, classicIds = false, dynamicJson = false, disableDefaultMutations = false, ignoreRbac = true, includeExtensionResources = false, exportSchemaJson: exportJsonSchemaPath, exportSchemaGraphql: exportGqlSchemaPath, sortExport = false, showErrorStack, extendedErrors = [], bodySizeLimit, appendPlugins: appendPluginNames, prependPlugins: prependPluginNames, 
// replaceAllPlugins is NOT exposed via the CLI
skipPlugins: skipPluginNames, readCache, writeCache, legacyRelations: rawLegacyRelations = 'deprecated', server: yesServer, clusterWorkers, enableQueryBatching, setofFunctionsContainNulls = true, legacyJsonUuid, disableQueryLog, simpleCollections, legacyFunctionsOnly, ignoreIndexes, } = Object.assign({}, postgraphilerc_1.default['options'], program, overridesFromOptions);
let legacyRelations;
if (['omit', 'only', 'deprecated'].indexOf(rawLegacyRelations) < 0) {
    throw new Error(`Invalid argument to '--legacy-relations' - expected on of 'omit', 'deprecated', 'only'; but received '${rawLegacyRelations}'`);
}
else {
    legacyRelations = rawLegacyRelations;
}
const noServer = !yesServer;
// Add custom logic for getting the schemas from our CLI. If we are in demo
// mode, we want to use the `forum_example` schema. Otherwise the `public`
// schema is what we want.
const schemas = dbSchema || (isDemo ? ['forum_example'] : ['public']);
const ownerConnectionString = ownerConnection || pgConnectionString || process.env.DATABASE_URL;
// Work around type mismatches between parsePgConnectionString and PoolConfig
const coerce = (o) => {
    return Object.assign({}, o, { application_name: o['application_name'] || undefined, ssl: o.ssl != null ? !!o.ssl : undefined, user: typeof o.user === 'string' ? o.user : undefined, database: typeof o.database === 'string' ? o.database : undefined, password: typeof o.password === 'string' ? o.password : undefined, port: o.port || typeof o.port === 'number' ? o.port : undefined, host: typeof o.host === 'string' ? o.host : undefined });
};
// Create our Postgres config.
const pgConfig = Object.assign({}, (pgConnectionString || process.env.DATABASE_URL || isDemo
    ? coerce(pg_connection_string_1.parse(pgConnectionString || process.env.DATABASE_URL || DEMO_PG_URL))
    : {
        host: process.env.PGHOST || 'localhost',
        port: (process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : null) || 5432,
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
    }), { 
    // Add the max pool size to our config.
    max: maxPoolSize });
const loadPlugins = (rawNames) => {
    if (!rawNames) {
        return undefined;
    }
    const names = Array.isArray(rawNames) ? rawNames : String(rawNames).split(',');
    return names.map(rawName => {
        if (typeof rawName === 'function') {
            return rawName;
        }
        const name = String(rawName);
        const parts = name.split(':');
        let root;
        try {
            root = require(String(parts.shift()));
        }
        catch (e) {
            // tslint:disable-next-line no-console
            console.error(`Failed to load plugin '${name}'`);
            throw e;
        }
        let plugin = root;
        while (true) {
            const part = parts.shift();
            if (part == null) {
                break;
            }
            plugin = root[part];
            if (plugin == null) {
                throw new Error(`No plugin found matching spec '${name}' - failed at '${part}'`);
            }
        }
        if (typeof plugin === 'function') {
            return plugin;
        }
        else if (plugin === root && typeof plugin.default === 'function') {
            return plugin.default; // ES6 workaround
        }
        else {
            throw new Error(`No plugin found matching spec '${name}' - expected function, found '${typeof plugin}'`);
        }
    });
};
if (jwtAudiences != null && jwtVerifyAudience != null) {
    throw new Error(`Provide either '--jwt-audiences' or '-A, --jwt-verify-audience' but not both`);
}
function trimNulls(obj) {
    return Object.keys(obj).reduce((memo, key) => {
        if (obj[key] != null) {
            memo[key] = obj[key];
        }
        return memo;
    }, {});
}
const jwtVerifyOptions = trimNulls({
    algorithms: jwtVerifyAlgorithms,
    audience: jwtVerifyAudience,
    clockTolerance: jwtVerifyClockTolerance,
    jwtId: jwtVerifyId,
    ignoreExpiration: jwtVerifyIgnoreExpiration,
    ignoreNotBefore: jwtVerifyIgnoreNotBefore,
    issuer: jwtVerifyIssuer,
    subject: jwtVerifySubject,
});
// The options to pass through to the schema builder, or the middleware
const postgraphileOptions = pluginHook('cli:library:options', Object.assign({}, postgraphilerc_1.default['options'], { classicIds,
    dynamicJson,
    disableDefaultMutations, ignoreRBAC: ignoreRbac, includeExtensionResources,
    graphqlRoute,
    graphiqlRoute, graphiql: !disableGraphiql, enhanceGraphiql: enhanceGraphiql ? true : undefined, graphiqlAuthorizationEventOrigin, jwtPgTypeIdentifier: jwtPgTypeIdentifier || deprecatedJwtPgTypeIdentifier, jwtSecret: jwtSecret || deprecatedJwtSecret, jwtAudiences,
    jwtRole,
    jwtVerifyOptions,
    retryOnInitFail,
    pgDefaultRole, subscriptions: subscriptions || live, live,
    watchPg,
    showErrorStack,
    extendedErrors,
    disableQueryLog,
    enableCors,
    exportJsonSchemaPath,
    exportGqlSchemaPath,
    sortExport,
    bodySizeLimit, appendPlugins: loadPlugins(appendPluginNames), prependPlugins: loadPlugins(prependPluginNames), skipPlugins: loadPlugins(skipPluginNames), readCache,
    writeCache,
    legacyRelations,
    setofFunctionsContainNulls,
    legacyJsonUuid,
    enableQueryBatching,
    pluginHook,
    simpleCollections,
    legacyFunctionsOnly,
    ignoreIndexes,
    ownerConnectionString }), { config: postgraphilerc_1.default, cliOptions: program });
if (noServer) {
    // No need for a server, let's just spin up the schema builder
    (async () => {
        const pgPool = new pg_1.Pool(pgConfig);
        pgPool.on('error', err => {
            // tslint:disable-next-line no-console
            console.error('PostgreSQL client generated error: ', err.message);
        });
        const { getGraphQLSchema } = postgraphile_1.getPostgraphileSchemaBuilder(pgPool, schemas, postgraphileOptions);
        await getGraphQLSchema();
        if (!watchPg) {
            await pgPool.end();
        }
    })().then(null, e => {
        console.error('Error occurred!');
        console.error(e);
        process.exit(1);
    });
}
else {
    function killAllWorkers(signal = 'SIGTERM') {
        for (const id in cluster.workers) {
            if (cluster.workers.hasOwnProperty(id) && !!cluster.workers[id]) {
                cluster.workers[id].kill(signal);
            }
        }
    }
    if (clusterWorkers >= 2 && cluster.isMaster) {
        let shuttingDown = false;
        const shutdown = () => {
            if (!shuttingDown) {
                shuttingDown = true;
                process.exitCode = 1;
                const fallbackTimeout = setTimeout(() => {
                    const remainingCount = Object.keys(cluster.workers).length;
                    if (remainingCount > 0) {
                        console.log(`  [cluster] ${remainingCount} workers did not die fast enough, sending SIGKILL`);
                        killAllWorkers('SIGKILL');
                        const ultraFallbackTimeout = setTimeout(() => {
                            console.log(`  [cluster] really should have exited automatically, but haven't - exiting`);
                            process.exit(3);
                        }, 5000);
                        ultraFallbackTimeout.unref();
                    }
                    else {
                        console.log(`  [cluster] should have exited automatically, but haven't - exiting`);
                        process.exit(2);
                    }
                }, 5000);
                fallbackTimeout.unref();
                console.log(`  [cluster] killing other workers with SIGTERM`);
                killAllWorkers('SIGTERM');
            }
        };
        cluster.on('exit', (worker, code, signal) => {
            console.log(`  [cluster] worker pid=${worker.process.pid} exited (code=${code}, signal=${signal})`);
            shutdown();
        });
        for (let i = 0; i < clusterWorkers; i++) {
            const worker = cluster.fork({
                POSTGRAPHILE_WORKER_NUMBER: String(i + 1),
            });
            console.log(`  [cluster] started worker ${i + 1} (pid=${worker.process.pid})`);
        }
    }
    else {
        // Create’s our PostGraphile server
        const rawMiddleware = postgraphile_1.default(pgConfig, schemas, postgraphileOptions);
        // You probably don't want this hook; likely you want
        // `postgraphile:middleware` instead. This hook will likely be removed in
        // future without warning.
        const middleware = pluginHook(
        /* DO NOT USE -> */ 'cli:server:middleware' /* <- DO NOT USE */, rawMiddleware, {
            options: postgraphileOptions,
        });
        const server = http_1.createServer(middleware);
        if (serverTimeout) {
            server.timeout = serverTimeout;
        }
        if (postgraphileOptions.subscriptions) {
            subscriptions_1.enhanceHttpServerWithSubscriptions(server, middleware);
        }
        pluginHook('cli:server:created', server, {
            options: postgraphileOptions,
            middleware,
        });
        // Start our server by listening to a specific port and host name. Also log
        // some instructions and other interesting information.
        server.listen(port, hostname, () => {
            const address = server.address();
            const actualPort = typeof address === 'string' ? port : address.port;
            const self = cluster.isMaster
                ? isDev
                    ? `server (pid=${process.pid})`
                    : 'server'
                : `worker ${process.env.POSTGRAPHILE_WORKER_NUMBER} (pid=${process.pid})`;
            const versionString = `v${manifest.version}`;
            if (cluster.isMaster || process.env.POSTGRAPHILE_WORKER_NUMBER === '1') {
                console.log('');
                console.log(`PostGraphile ${versionString} ${self} listening on port ${chalk_1.default.underline(actualPort.toString())} 🚀`);
                console.log('');
                const { host: rawPgHost, port: rawPgPort, database: pgDatabase, user: pgUser, password: pgPassword, } = pgConfig;
                // Not using default because want to handle the empty string also.
                const pgHost = rawPgHost || 'localhost';
                const pgPort = (rawPgPort && parseInt(String(rawPgPort), 10)) || 5432;
                const safeConnectionString = isDemo
                    ? 'postgraphile_demo'
                    : `postgres://${pgUser ? pgUser : ''}${pgPassword ? ':[SECRET]' : ''}${pgUser || pgPassword ? '@' : ''}${pgUser || pgPassword || pgHost !== 'localhost' || pgPort !== 5432 ? pgHost : ''}${pgPort !== 5432 ? `:${pgConfig.port || 5432}` : ''}${pgDatabase ? `/${pgDatabase}` : ''}`;
                const information = pluginHook('cli:greeting', [
                    `GraphQL API:         ${chalk_1.default.underline.bold.blue(`http://${hostname}:${actualPort}${graphqlRoute}`)}` +
                        (postgraphileOptions.subscriptions
                            ? ` (${postgraphileOptions.live ? 'live ' : ''}subscriptions enabled)`
                            : ''),
                    !disableGraphiql &&
                        `GraphiQL GUI/IDE:    ${chalk_1.default.underline.bold.blue(`http://${hostname}:${actualPort}${graphiqlRoute}`)}` +
                            (postgraphileOptions.enhanceGraphiql ||
                                postgraphileOptions.live ||
                                postgraphileOptions.subscriptions
                                ? ''
                                : ` (enhance with '--enhance-graphiql')`),
                    `Postgres connection: ${chalk_1.default.underline.magenta(safeConnectionString)}${postgraphileOptions.watchPg ? ' (watching)' : ''}`,
                    `Postgres schema(s):  ${schemas.map(schema => chalk_1.default.magenta(schema)).join(', ')}`,
                    `Documentation:       ${chalk_1.default.underline(`https://graphile.org/postgraphile/introduction/`)}`,
                    extractedPlugins.length === 0
                        ? `Join ${chalk_1.default.bold(sponsor)} in supporting PostGraphile development: ${chalk_1.default.underline.bold.blue(`https://graphile.org/sponsor/`)}`
                        : null,
                ], {
                    options: postgraphileOptions,
                    middleware,
                    port: actualPort,
                    chalk: chalk_1.default,
                }).filter(isString);
                console.log(information.map(msg => `  ‣ ${msg}`).join('\n'));
                console.log('');
                console.log(chalk_1.default.gray('* * *'));
            }
            else {
                console.log(`PostGraphile ${versionString} ${self} listening on port ${chalk_1.default.underline(actualPort.toString())} 🚀`);
            }
            console.log('');
        });
    }
}
/* eslint-enable */
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3Bvc3RncmFwaGlsZS9jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFDQSw0QkFBNEI7O0FBRTVCOzs7Ozs7R0FNRztBQUNILHFEQUFzQztBQUV0QywrQkFBb0M7QUFDcEMsaUNBQTBCO0FBQzFCLHFDQUFzQztBQUV0QywrREFBd0U7QUFDeEUsaURBQTRFO0FBQzVFLDJCQUFzQztBQUN0QyxtQ0FBb0M7QUFDcEMsNkNBQWtFO0FBQ2xFLHNDQUF1QztBQUV2QywrQ0FBK0M7QUFDL0MsZ0RBQWlEO0FBQ2pELHdEQUEwRTtBQUUxRSxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixLQUFLLGFBQWEsQ0FBQztBQUU3RCxrQ0FBa0M7QUFDbEMsU0FBUyxRQUFRLENBQUMsR0FBUTtJQUN4QixPQUFPLE9BQU8sR0FBRyxLQUFLLFFBQVEsQ0FBQztBQUNqQyxDQUFDO0FBRUQsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBRXRFLE1BQU0sUUFBUSxHQUFHLFlBQVksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBRWxELCtCQUErQjtBQUMvQixNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFFekIsU0FBUyxjQUFjLENBQ3JCLE9BQXNCO0lBS3RCLElBQUksSUFBSSxDQUFDO0lBQ1QsSUFBSSxhQUFhLEdBQUcsRUFBRSxDQUFDO0lBQ3ZCLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFdBQVcsRUFBRTtRQUM5QixhQUFhLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN0QyxJQUFJLEdBQUcsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxF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