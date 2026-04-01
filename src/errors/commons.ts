export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "@mateusseiboth/client-error";
  }
}
