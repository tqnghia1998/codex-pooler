export async function writeChunk(res, chunk) {
  if (res.destroyed || res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', failed);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', failed);
    if (res.destroyed) done();
  });
}
