export function samplePdf(label = "Original"): Buffer {
	const twoColumns = `BT /F1 12 Tf 50 700 Td (${label} left column) Tj ET\nBT /F1 12 Tf 280 700 Td (${label} right column) Tj ET`;
	const colors = "1 0 0 rg 10 20 400 400 re f 0 0 1 rg 10 420 400 400 re f";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /CropBox [10 20 410 820] /Rotate 90 /Contents 7 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(twoColumns)} >>\nstream\n${twoColumns}\nendstream`,
		`<< /Length ${Buffer.byteLength(colors)} >>\nstream\n${colors}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, i) => {
		const at = Buffer.byteLength(pdf);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
		return `${String(at).padStart(10, "0")} 00000 n \n`;
	});
	return Buffer.from(
		`${pdf}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(pdf)}\n%%EOF\n`,
	);
}

export function textPdf(lines: readonly string[]): Buffer {
	const content = lines.map((line, i) => `BT /F1 4 Tf 20 ${820 - i * 5} Td (${line}) Tj ET`).join("\n");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, i) => {
		const at = Buffer.byteLength(pdf);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
		return `${String(at).padStart(10, "0")} 00000 n \n`;
	});
	return Buffer.from(
		`${pdf}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(pdf)}\n%%EOF\n`,
	);
}
