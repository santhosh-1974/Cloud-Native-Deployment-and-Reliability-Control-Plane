/**
 * Input validation schemas for the Deployment Control Plane API.
 *
 * All validation is pure: schemas return `{ ok, value, error }` so route
 * handlers can call them without try/catch.  No external validation library
 * is introduced; the project has none.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationFail {
  ok: false;
  error: string;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationFail;

function ok<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}

function fail(error: string): ValidationFail {
  return { ok: false, error };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Application schemas
// ---------------------------------------------------------------------------

export interface RegisterApplicationInput {
  name: string;
  config?: Record<string, unknown>;
}

/**
 * Validate POST /applications body.
 *
 * - `name`: required, non-empty string, max 255 chars, alphanumeric + hyphens/underscores/dots.
 * - `config`: optional plain object (no secrets).
 */
export function validateRegisterApplication(body: unknown): ValidationResult<RegisterApplicationInput> {
  if (!isObject(body)) return fail('Request body must be a JSON object');

  const { name, config } = body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return fail('`name` is required and must be a non-empty string');
  }
  const trimmedName = name.trim();
  if (trimmedName.length > 255) {
    return fail('`name` must be 255 characters or fewer');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmedName)) {
    return fail('`name` must start with a letter or digit and may only contain letters, digits, hyphens, underscores, and dots');
  }

  if (config !== undefined && !isObject(config)) {
    return fail('`config` must be a plain JSON object when provided');
  }

  return ok({
    name: trimmedName,
    ...(config !== undefined ? { config: config as Record<string, unknown> } : {}),
  } as RegisterApplicationInput);
}

// ---------------------------------------------------------------------------
// Deployment schemas
// ---------------------------------------------------------------------------

export interface CanaryStrategy {
  type: 'canary';
  steps: number[];
}

export type DeploymentStrategy = CanaryStrategy;

export interface CreateDeploymentInput {
  image: string;
  replicas: number;
  port: number;
  strategy: DeploymentStrategy;
  requestIdentity?: string;
  stableImage?: string;
}

/**
 * Validate POST /applications/:applicationId/deployments body.
 *
 * - `image`: required non-empty string (container image reference).
 * - `replicas`: required integer 1–100.
 * - `port`: required integer 1–65535.
 * - `strategy`: required object with `type: 'canary'` and `steps` array.
 * - `requestIdentity`: optional caller-supplied idempotency key (UUID or
 *   any string up to 255 chars).
 * - `stableImage`: optional previous healthy image for rollback.
 */
export function validateCreateDeployment(body: unknown): ValidationResult<CreateDeploymentInput> {
  if (!isObject(body)) return fail('Request body must be a JSON object');

  const { image, replicas, port, strategy, requestIdentity, stableImage } = body;

  // image
  if (typeof image !== 'string' || image.trim().length === 0) {
    return fail('`image` is required and must be a non-empty string');
  }
  if (image.trim().length > 512) {
    return fail('`image` must be 512 characters or fewer');
  }

  // replicas
  if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < 1 || replicas > 100) {
    return fail('`replicas` must be an integer between 1 and 100');
  }

  // port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return fail('`port` must be an integer between 1 and 65535');
  }

  // strategy
  const strategyResult = validateStrategy(strategy);
  if (!strategyResult.ok) return fail(strategyResult.error);

  // requestIdentity (optional)
  if (requestIdentity !== undefined) {
    if (typeof requestIdentity !== 'string' || requestIdentity.trim().length === 0) {
      return fail('`requestIdentity` must be a non-empty string when provided');
    }
    if (requestIdentity.trim().length > 255) {
      return fail('`requestIdentity` must be 255 characters or fewer');
    }
  }

  // stableImage (optional)
  if (stableImage !== undefined) {
    if (typeof stableImage !== 'string' || stableImage.trim().length === 0) {
      return fail('`stableImage` must be a non-empty string when provided');
    }
    if (stableImage.trim().length > 512) {
      return fail('`stableImage` must be 512 characters or fewer');
    }
  }

  return ok({
    image: image.trim(),
    replicas,
    port,
    strategy: strategyResult.value,
    ...(requestIdentity !== undefined ? { requestIdentity: requestIdentity.trim() } : {}),
    ...(stableImage !== undefined ? { stableImage: stableImage.trim() } : {}),
  });
}

function validateStrategy(strategy: unknown): ValidationResult<DeploymentStrategy> {
  if (!isObject(strategy)) return fail('`strategy` must be a plain JSON object');

  const { type, steps } = strategy;

  if (type !== 'canary') {
    return fail('`strategy.type` must be "canary"');
  }

  if (!Array.isArray(steps)) {
    return fail('`strategy.steps` must be an array of traffic percentages');
  }
  if (steps.length === 0) {
    return fail('`strategy.steps` must contain at least one stage');
  }
  if (steps.length > 20) {
    return fail('`strategy.steps` must contain 20 stages or fewer');
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > 100) {
      return fail(`\`strategy.steps[${i}]\` must be an integer between 1 and 100`);
    }
  }

  // Final step must be 100 (full promotion)
  const lastStep = steps[steps.length - 1];
  if (lastStep !== 100) {
    return fail('`strategy.steps` must end with 100 (full traffic promotion)');
  }

  return ok({ type: 'canary', steps: steps as number[] });
}
