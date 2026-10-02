import 'dotenv/config';
import { prisma } from '../config/prisma.js';
import { assertNumericSchemaShape } from '../lib/schemaShapeGuard.js';
import { ensureDefaultWorkflows } from '../services/approvalInstance.service.js';
import { backfillPendingApprovals } from '../services/approval.service.js';

/**
 * `npm run approval:backfill` — safe to run any number of times.
 *
 *  1. every company gets its default one-step workflows (Leave / OT / Attendance Correction);
 *  2. every PENDING Leave / OT / Attendance Correction that has no approval instance gets one from
 *     its company's CURRENT default workflow (so nothing submitted before Phase 9 is stranded).
 *
 * Completed legacy requests (APPROVED / REJECTED / CANCELLED) are NOT touched: no approval history
 * is invented for them.
 */
async function main() {
	await assertNumericSchemaShape();
	const companies = await prisma.company.findMany({ select: { id: true, code: true } });
	let workflows = 0;
	for (const c of companies) workflows += (await ensureDefaultWorkflows(c.id)).length;
	console.log(
		`Default workflows created: ${workflows} (${companies.length} company(ies) checked).`
	);

	const result = await backfillPendingApprovals();
	console.log(`Instances created: ${result.created}, already had one: ${result.alreadyHad}.`);
	if (result.failed.length > 0) {
		console.log('Could not backfill (usually APPROVER_NOT_FOUND — fix the workflow, then re-run):');
		for (const f of result.failed) console.log(` - ${f.targetType} ${f.targetId}: ${f.code}`);
		process.exitCode = 1;
	}
}

main()
	.catch((err: unknown) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => void prisma.$disconnect());
