export type ActivityPerson = {
  accountId: number | null;
  username: string | null;
  displayName: string | null;
  copyReview: number;
  copyRework: number;
  imageReview: number;
  imageFirstReview: number;
  imageRework: number;
  imagePassed: number;
  deliveryTotal: number;
};

export const activityColumns = [
  { label: '标注人', hint: '这些作业归属的标注人。' },
  { label: '文案作业次数', hint: '记录该人员文案首次审核和文案返修的次数总和' },
  { label: '文案首次审核', hint: '记录该人员对文案进行第一次审核的次数' },
  { label: '文案返修', hint: '记录该人员对文案质检打回任务进行的返修次数' },
  { label: '图片作业次数', hint: '记录该人员图片首次审核和图片返修的次数总和' },
  { label: '图片首次审核', hint: '记录该人员对图片进行第一次审核的次数' },
  { label: '图片返修', hint: '记录该人员对图片质检打回任务进行的返修次数' },
  { label: '图片通过数量', hint: '记录该人员审核过的图片最终通过质检或者被放行的任务数量' },
  { label: '新增交付数', hint: '记录该人员新增进入交付池的任务数量' },
] as const;

export function visibleActivityPeople(people: ActivityPerson[]) {
  return people.filter(person => person.copyReview || person.copyRework
    || person.imageReview || person.imagePassed || person.deliveryTotal);
}

function personName(person: ActivityPerson) {
  const name = person.displayName || person.username
    || (person.accountId ? `账号 #${person.accountId}` : '未归属人员');
  return person.username && person.displayName && person.username !== person.displayName
    ? `${name}（${person.username}）` : name;
}

function escapeXml(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

export async function activityDetailWorkbook(people: ActivityPerson[]) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const rows: (string | number)[][] = [
    activityColumns.map(column => column.label),
    ...visibleActivityPeople(people).map(person => [
      personName(person), person.copyReview + person.copyRework,
      person.copyReview, person.copyRework, person.imageReview,
      person.imageFirstReview, person.imageRework,
      person.imagePassed, person.deliveryTotal,
    ]),
  ];
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, index) => {
    const address = `${String.fromCharCode(65 + index)}${rowIndex + 1}`;
    return typeof value === 'number'
      ? `<c r="${address}"><v>${value}</v></c>`
      : `<c r="${address}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="作业详情" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="9" width="18" customWidth="1"/></cols>
<sheetData>${sheetRows}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
