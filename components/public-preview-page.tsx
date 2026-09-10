import { PublicPreviewView } from '@/components/public-preview-view';
import { getPublicPreview } from '@/lib/server/preview-repository';

export async function PublicPreviewPage({ publicId }: { publicId?: string }) {
  const preview =
    publicId && /^[0-9a-f]{32}$/iu.test(publicId)
      ? await getPublicPreview(publicId)
      : null;

  if (!preview || preview.status === 'REVOKED') {
    return <UnavailablePreview revoked={preview?.status === 'REVOKED'} />;
  }

  return <PublicPreviewView preview={preview} />;
}

function UnavailablePreview({ revoked }: { revoked: boolean }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f1e9] px-6 py-16 text-[#292521]">
      <section className="w-full max-w-lg border border-[#d9d0c3] bg-[#fffdf8] p-8 text-center shadow-[0_20px_60px_rgb(52_43_34/8%)] sm:p-12">
        <div className="mx-auto grid size-12 place-items-center rounded-full border border-[#d9d0c3] font-heading text-xl text-[#a33a2a]">
          ×
        </div>
        <p className="mt-7 font-mono text-[10px] uppercase tracking-[0.2em] text-[#8b8075]">
          Preview unavailable
        </p>
        <h1 className="mt-3 font-heading text-2xl font-semibold">
          {revoked ? '这个预览已停止访问' : '没有找到这个预览'}
        </h1>
        <p className="mt-3 text-sm leading-7 text-[#766c63]">
          {revoked
            ? '发布者已撤销公开链接，页面内容和原图均不再对外提供。'
            : '链接可能不完整，或对应内容尚未发布。请向链接提供者确认。'}
        </p>
      </section>
    </main>
  );
}
