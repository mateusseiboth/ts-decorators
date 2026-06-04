type Handler = (...args: any[]) => any;
type Wrapper = (handler: Handler) => Handler;

export function compose(...wrappers: Wrapper[]) {
  return function (handler: Handler): Handler {
    return wrappers.reduceRight((acc, wrapper) => wrapper(acc), handler);
  };
}
