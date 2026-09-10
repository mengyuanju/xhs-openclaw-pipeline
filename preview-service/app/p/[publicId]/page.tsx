import { PublicPreviewPage } from '@/components/public-preview-page';

export const dynamic = 'force-dynamic';

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;

  return <PublicPreviewPage publicId={publicId} />;
}
