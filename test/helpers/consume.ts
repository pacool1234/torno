export async function consume<T>(
  stream: AsyncIterable<T>,
): Promise<{ events: T[]; error: unknown }> {
  const events: T[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error: unknown) {
    return { events, error };
  }
}
