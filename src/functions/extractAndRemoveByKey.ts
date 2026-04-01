export function extractAndRemoveByKey(obj: any, keyparams: string): { value?: any; obj: any } {
    let foundValue: any;

    function recurse(o: any) {
        if (Array.isArray(o)) {
            o.forEach(recurse);
        } else if (o && typeof o === "object") {
            for (const key of Object.keys(o)) {
                if (key === keyparams) {
                    foundValue = o[key];
                    delete o[key];
                } else {
                    recurse(o[key]);
                }
            }
        }
    }

    recurse(obj);
    return { value: foundValue, obj };
}
