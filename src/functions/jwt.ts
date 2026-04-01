export function jwtDecode(token: string): Record<string, any> {
    if (!token) {
        return {};
    }
    const [, payload] = token.split(".");
    if (!payload) {
        return {};
    }
    const decodedPayload = Buffer.from(payload, 'base64').toString('utf-8');
    return JSON.parse(decodedPayload);
}