/**
 * Lista guardada no metadado da classe pelos decorators legados (@Cron, @Listen, @Processor,
 * @MaskSensitive, @RegistryRouter).
 *
 * `Reflect.getMetadata` devolve a lista HERDADA quando a subclasse ainda não tem a dela. Dar `push`
 * nessa lista alterava a da classe base: a base passava a agendar, assinar e mascarar o que só a
 * subclasse declarou. Aqui a subclasse ganha uma CÓPIA da herdada com o item novo, e a base não muda.
 */
import "reflect-metadata";

export function appendMetadataItem<T>(key: unknown, target: object, item: T): readonly T[] {
  const inherited: readonly T[] = Reflect.getMetadata(key, target) ?? [];
  const list = [...inherited, item];
  Reflect.defineMetadata(key, list, target);
  return list;
}
