export class AppError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = 'APPLICATION_ERROR') { super(message); this.name = 'AppError'; }
}
