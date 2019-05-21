"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const graphql_1 = require("graphql");
const WebSocket = require("ws");
const subscriptions_transport_ws_1 = require("subscriptions-transport-ws");
const parseUrl = require("parseurl");
const pluginHook_1 = require("../pluginHook");
const createPostGraphileHttpRequestHandler_1 = require("./createPostGraphileHttpRequestHandler");
const liveSubscribe_1 = require("./liveSubscribe");
function lowerCaseKeys(obj) {
    return Object.keys(obj).reduce((memo, key) => {
        memo[key.toLowerCase()] = obj[key];
        return memo;
    }, {});
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });
    // tslint:disable-next-line prefer-object-spread
    return Object.assign(promise, {
        // @ts-ignore This isn't used before being defined.
        resolve,
        // @ts-ignore This isn't used before being defined.
        reject,
    });
}
async function enhanceHttpServerWithSubscriptions(websocketServer, postgraphileMiddleware, subscriptionServerOptions) {
    if (websocketServer['__postgraphileSubscriptionsEnabled']) {
        return;
    }
    websocketServer['__postgraphileSubscriptionsEnabled'] = true;
    const { options, getGraphQLSchema, withPostGraphileContextFromReqRes, handleErrors, } = postgraphileMiddleware;
    const pluginHook = pluginHook_1.pluginHookFromOptions(options);
    const externalUrlBase = options.externalUrlBase || '';
    const graphqlRoute = options.graphqlRoute || '/graphql';
    const schema = await getGraphQLSchema();
    const keepalivePromisesByContextKey = {};
    const contextKey = (ws, opId) => ws['postgraphileId'] + '|' + opId;
    const releaseContextForSocketAndOpId = (ws, opId) => {
        const promise = keepalivePromisesByContextKey[contextKey(ws, opId)];
        if (promise) {
            promise.resolve();
            keepalivePromisesByContextKey[contextKey(ws, opId)] = null;
        }
    };
    const addContextForSocketAndOpId = (context, ws, opId) => {
        releaseContextForSocketAndOpId(ws, opId);
        const promise = deferred();
        promise['context'] = context;
        keepalivePromisesByContextKey[contextKey(ws, opId)] = promise;
        return promise;
    };
    const applyMiddleware = async (middlewares = [], req, res) => {
        for (const middleware of middlewares) {
            // TODO: add Koa support
            await new Promise((resolve, reject) => {
                middleware(req, res, err => (err ? reject(err) : resolve()));
            });
        }
    };
    const reqResFromSocket = async (socket) => {
        const req = socket['__postgraphileReq'];
        if (!req) {
            throw new Error('req could not be extracted');
        }
        let dummyRes = socket['__postgraphileRes'];
        if (req.res) {
            throw new Error("Please get in touch with Benjie; we weren't expecting req.res to be present but we want to reserve it for future usage.");
        }
        if (!dummyRes) {
            dummyRes = new http_1.ServerResponse(req);
            dummyRes.writeHead = (statusCode, _statusMessage, headers) => {
                if (statusCode && statusCode > 200) {
                    // tslint:disable-next-line no-console
                    console.error(`Something used 'writeHead' to write a '${statusCode}' error for websockets - check the middleware you're passing!`);
                    socket.close();
                }
                else if (headers) {
                    // tslint:disable-next-line no-console
                    console.error("Passing headers to 'writeHead' is not supported with websockets currently - check the middleware you're passing");
                    socket.close();
                }
            };
            await applyMiddleware(options.websocketMiddlewares, req, dummyRes);
            socket['__postgraphileRes'] = dummyRes;
        }
        return { req, res: dummyRes };
    };
    const getContext = (socket, opId) => {
        return new Promise((resolve, reject) => {
            reqResFromSocket(socket)
                .then(({ req, res }) => withPostGraphileContextFromReqRes(req, res, { singleStatement: true }, context => {
                const promise = addContextForSocketAndOpId(context, socket, opId);
                resolve(promise['context']);
                return promise;
            }))
                .then(null, reject);
        });
    };
    const wss = new WebSocket.Server({ noServer: true });
    let socketId = 0;
    websocketServer.on('upgrade', (req, socket, head) => {
        const { pathname = '' } = parseUrl(req) || {};
        const isGraphqlRoute = pathname === externalUrlBase + graphqlRoute;
        if (isGraphqlRoute) {
            wss.handleUpgrade(req, socket, head, ws => {
                wss.emit('connection', ws, req);
            });
        }
    });
    const staticValidationRules = pluginHook('postgraphile:validationRules:static', graphql_1.specifiedRules, {
        options,
    });
    subscriptions_transport_ws_1.SubscriptionServer.create(Object.assign({ schema, validationRules: staticValidationRules, execute: () => {
            throw new Error('Only subscriptions are allowed over websocket transport');
        }, subscribe: options.live ? liveSubscribe_1.default : graphql_1.subscribe, onConnect(connectionParams, _socket, connectionContext) {
            const { socket, request } = connectionContext;
            socket['postgraphileId'] = ++socketId;
            if (!request) {
                throw new Error('No request!');
            }
            const normalizedConnectionParams = lowerCaseKeys(connectionParams);
            request['connectionParams'] = connectionParams;
            request['normalizedConnectionParams'] = normalizedConnectionParams;
            socket['__postgraphileReq'] = request;
            if (!request.headers.authorization && normalizedConnectionParams['authorization']) {
                /*
                 * Enable JWT support through connectionParams.
                 *
                 * For other headers you'll need to do this yourself for security
                 * reasons (e.g. we don't want to allow overriding of Origin /
                 * Referer / etc)
                 */
                request.headers.authorization = String(normalizedConnectionParams['authorization']);
            }
            socket['postgraphileHeaders'] = Object.assign({}, normalizedConnectionParams, request.headers);
        },
        // tslint:disable-next-line no-any
        async onOperation(message, params, socket) {
            const opId = message.id;
            const context = await getContext(socket, opId);
            // Override schema (for --watch)
            params.schema = await getGraphQLSchema();
            Object.assign(params.context, context);
            const { req, res } = await reqResFromSocket(socket);
            const meta = {};
            const formatResponse = (response) => {
                if (response.errors) {
                    response.errors = handleErrors(response.errors, req, res);
                }
                if (!createPostGraphileHttpRequestHandler_1.isEmpty(meta)) {
                    response['meta'] = meta;
                }
                return response;
            };
            params.formatResponse = formatResponse;
            const hookedParams = pluginHook
                ? pluginHook('postgraphile:ws:onOperation', params, {
                    message,
                    params,
                    socket,
                    options,
                })
                : params;
            const finalParams = Object.assign({}, hookedParams, { query: typeof hookedParams.query !== 'string' ? hookedParams.query : graphql_1.parse(hookedParams.query) });
            // You are strongly encouraged to use
            // `postgraphile:validationRules:static` if possible - you should
            // only use this one if you need access to variables.
            const moreValidationRules = pluginHook('postgraphile:validationRules', [], {
                options,
                req,
                res,
                variables: params.variables,
                operationName: params.operationName,
                meta,
            });
            if (moreValidationRules.length) {
                const validationErrors = graphql_1.validate(params.schema, finalParams.query, moreValidationRules);
                if (validationErrors.length) {
                    const error = new Error('Query validation failed: \n' + validationErrors.map(e => e.message).join('\n'));
                    error['errors'] = validationErrors;
                    return Promise.reject(error);
                }
            }
            return finalParams;
        },
        onOperationComplete(socket, opId) {
            releaseContextForSocketAndOpId(socket, opId);
        }, 
        /*
         * Heroku times out after 55s:
         *   https://devcenter.heroku.com/articles/error-codes#h15-idle-connection
         *
         * The subscriptions-transport-ws client times out by default 30s after last keepalive:
         *   https://github.com/apollographql/subscriptions-transport-ws/blob/52758bfba6190169a28078ecbafd2e457a2ff7a8/src/defaults.ts#L1
         *
         * GraphQL Playground times out after 20s:
         *   https://github.com/prisma/graphql-playground/blob/fa91e1b6d0488e6b5563d8b472682fe728ee0431/packages/graphql-playground-react/src/state/sessions/fetchingSagas.ts#L81
         *
         * Pick a number under these ceilings.
         */
        keepAlive: 15000 }, subscriptionServerOptions), wss);
}
exports.enhanceHttpServerWithSubscriptions = enhanceHttpServerWithSubscriptions;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3Vic2NyaXB0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9wb3N0Z3JhcGhpbGUvaHR0cC9zdWJzY3JpcHRpb25zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsK0JBQStEO0FBRS9ELHFDQVFpQjtBQUNqQixnQ0FBZ0M7QUFDaEMsMkVBQW9HO0FBQ3BHLHFDQUFzQztBQUN0Qyw4Q0FBc0Q7QUFDdEQsaUdBQWlFO0FBQ2pFLG1EQUE0QztBQU81QyxTQUFTLGFBQWEsQ0FBQyxHQUFXO0lBQ2hDLE9BQU8sTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsR0FBRyxFQUFFLEVBQUU7UUFDM0MsSUFBSSxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQyxPQUFPLElBQUksQ0FBQztJQUNkLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNULENBQUM7QUFFRCxTQUFTLFFBQVE7SUFDZixJQUFJLE9BQXlELENBQUM7SUFDOUQsSUFBSSxNQUE4QixDQUFDO0lBQ25DLE1BQU0sT0FBTyxHQUFHLElBQUksT0FBTyxDQUFJLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxFQUFFO1FBQ25ELE9BQU8sR0FBRyxRQUFRLENBQUM7UUFDbkIsTUFBTSxHQUFHLE9BQU8sQ0FBQztJQUNuQixDQUFDLENBQUMsQ0FBQztJQUNILGdEQUFnRDtJQUNoRCxPQUFPLE1BQU0sQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFO1FBQzVCLG1EQUFtRDtRQUNuRCxPQUFPO1FBQ1AsbURBQW1EO1FBQ25ELE1BQU07S0FDUCxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRU0sS0FBSyxVQUFVLGtDQUFrQyxDQUN0RCxlQUF1QixFQUN2QixzQkFBMEMsRUFDMUMseUJBRUM7SUFFRCxJQUFJLGVBQWUsQ0FBQyxvQ0FBb0MsQ0FB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