"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Extracts the requested fields from a pg error object, handling 'code' -> 'errcode' mapping.
 */
function pickPgError(err, inFields) {
    const result = {};
    let fields;
    if (Array.isArray(inFields)) {
        fields = inFields;
    }
    else if (typeof inFields === 'string') {
        fields = inFields.split(',');
    }
    else {
        throw new Error('Invalid argument to extendedErrors - expected array of strings');
    }
    if (err && typeof err === 'object') {
        fields.forEach((field) => {
            // pg places 'errcode' on the 'code' property
            if (typeof field !== 'string') {
                throw new Error('Invalid argument to extendedErrors - expected array of strings');
            }
            const errField = field === 'errcode' ? 'code' : field;
            result[field] = err[errField] != null ? String(err[errField]) : err[errField];
        });
    }
    return result;
}
/**
 * Given a GraphQLError, format it according to the rules described by the
 * Response Format, Errors section of the GraphQL Specification, plus it can
 * extract additional error codes from the postgres error, such as 'hint',
 * 'detail', 'errcode', 'where', etc. - see `extendedErrors` option.
 */
function extendedFormatError(error, fields) {
    if (!error) {
        throw new Error('Received null or undefined error.');
    }
    const originalError = error.originalError;
    const exceptionDetails = originalError && fields ? pickPgError(originalError, fields) : undefined;
    return Object.assign({}, exceptionDetails, (exceptionDetails
        ? {
            // Reference: https://facebook.github.io/graphql/draft/#sec-Errors
            extensions: Object.assign({}, originalError.extensions, { exception: exceptionDetails }),
        }
        : null), { message: error.message, locations: error.locations, path: error.path });
}
exports.extendedFormatError = extendedFormatError;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXh0ZW5kZWRGb3JtYXRFcnJvci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9wb3N0Z3JhcGhpbGUvZXh0ZW5kZWRGb3JtYXRFcnJvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUdBOztHQUVHO0FBQ0gsU0FBUyxXQUFXLENBQUMsR0FBVSxFQUFFLFFBQWdDO0lBQy9ELE1BQU0sTUFBTSxHQUFVLEVBQUUsQ0FBQztJQUN6QixJQUFJLE1BQU0sQ0FBQztJQUNYLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsRUFBRTtRQUMzQixNQUFNLEdBQUcsUUFBUSxDQUFDO0tBQ25CO1NBQU0sSUFBSSxPQUFPLFFBQVEsS0FBSyxRQUFRLEVBQUU7UUFDdkMsTUFBTSxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7S0FDOUI7U0FBTTtRQUNMLE1BQU0sSUFBSSxLQUFLLENBQUMsZ0VBQWdFLENBQUMsQ0FBQztLQUNuRjtJQUVELElBQUksR0FBRyxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRTtRQUNsQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBYSxFQUFFLEVBQUU7WUFDL0IsNkNBQTZDO1lBQzdDLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFO2dCQUM3QixNQUFNLElBQUksS0FBSyxDQUFDLGdFQUFnRSxDQUFDLENBQUM7YUFDbkY7WUFDRCxNQUFNLFFBQVEsR0FBRyxLQUFLLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztZQUN0RCxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDaEYsQ0FBQyxDQUFDLENBQUM7S0FDSjtJQUNELE9BQU8sTUFBTSxDQUFDO0FBQ2hCLENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILFNBQWdCLG1CQUFtQixDQUNqQyxLQUFtQixFQUNuQixNQUFxQjtJQUVyQixJQUFJLENBQUMsS0FBSyxFQUFFO1FBQ1YsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQ0FBbUMsQ0FBQyxDQUFDO0tBQ3REO0lBQ0QsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQXFDLENBQUM7SUFDbEUsTUFBTSxnQkFBZ0IsR0FBRyxhQUFhLElBQUksTUFBTSxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsYUFBYSxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDbEcseUJBRUssZ0JBQWdCLEVBRWhCLENBQUMsZ0JBQWdCO1FBQ2xCLENBQUMsQ0FBQztZQUNFLGtFQUFrRTtZQUNsRSxVQUFVLG9CQUNMLGFBQWEsQ0FBQyxVQUFVLElBQzNCLFNBQVMsRUFBRSxnQkFBZ0IsR0FDNUI7U0FDRjtRQUNILENBQUMsQ0FBQyxJQUFJLENBQUMsSUFDVCxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFDdEIsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTLEVBQzFCLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxJQUNoQjtBQUNKLENBQUM7QUExQkQsa0RBMEJDIn0=