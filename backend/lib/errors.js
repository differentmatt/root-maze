// Thrown when caller-supplied input is invalid *after* it needs a database
// lookup to validate (e.g. an edge that references a node which doesn't exist).
// Handlers catch this and turn it into a 400. Pure shape/enum checks that need
// no DB access stay in the handler layer, next to the request parsing.
export class ValidationError extends Error {}
