// Bring a photo taken with the iPhone Camera (or any camera) into a view.
// The file is stored untouched as the clinical master; only a thumbnail is derived.
import { db, uid, type Capture } from './db';
import { readPhotoSettings } from './exif';

export async function importPhoto(file: File, patientId: string, viewKey: string, mainCamera35 = 26): Promise<Capture> {
  // capture settings recorded by the camera that took the photo (zoom, exposure, ISO, date)
  const exif = await readPhotoSettings(file, mainCamera35);
  const bmp = await createImageBitmap(file);
  const s = 360 / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const thumb = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('thumbnail failed'))), 'image/jpeg', 0.8));
  const v = await db.getView(patientId, viewKey);
  const isBaseline = !v?.baselineId;
  const rec: Capture = {
    id: uid(),
    patientId,
    viewKey,
    role: isBaseline ? 'baseline' : 'followup',
    createdAt: exif?.takenAt ? Date.parse(exif.takenAt) : file.lastModified || Date.now(),
    master: file,
    thumb,
    width: bmp.width,
    height: bmp.height,
    meta: {
      imported: true,
      exif,
      // zoom to reproduce on the live camera; below 1x (ultra-wide) cannot be matched by the main camera
      zoom: exif?.zoom ? Math.max(1, Math.min(8, exif.zoom)) : undefined,
      zoomSource: exif?.zoom ? 'photo' : undefined,
      fileName: file.name,
      fileType: file.type,
      fileDate: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      importedAt: new Date().toISOString(),
      integrity: 'Imported file stored byte-for-byte as received from the photo picker.',
    },
  };
  bmp.close();
  await db.putCapture(rec);
  await db.putView({ key: `${patientId}|${viewKey}`, patientId, viewKey, baselineId: v?.baselineId ?? rec.id, createdAt: v?.createdAt ?? Date.now() });
  await db.touchPatient(patientId);
  return rec;
}
