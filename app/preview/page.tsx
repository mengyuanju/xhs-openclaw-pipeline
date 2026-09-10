import { PublicPreviewPage } from '@/components/public-preview-page';

export const dynamic = 'force-dynamic';

export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ noteId?: string | string[] }>;
}) {
  const { noteId } = await searchParams;

  return (
    <PublicPreviewPage
      publicId={typeof noteId === 'string' ? noteId : undefined}
    />
  );
}
