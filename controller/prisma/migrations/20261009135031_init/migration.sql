-- CreateEnum
CREATE TYPE "public"."DeploymentStatus" AS ENUM ('PENDING', 'DEPLOYING', 'CANARY', 'VALIDATING', 'PROMOTING', 'SUCCEEDED', 'CANARY_FAILED', 'ROLLING_BACK', 'ROLLED_BACK', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."StageStatus" AS ENUM ('UNEVALUATED', 'INTENT_RECORDED', 'APPLYING', 'APPLIED', 'VALIDATING', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."EvaluationResult" AS ENUM ('PASS', 'FAIL', 'INDETERMINATE');

-- CreateEnum
CREATE TYPE "public"."DeploymentEventType" AS ENUM ('DEPLOYMENT_CREATED', 'DEPLOYMENT_STARTED', 'STAGE_INTENT_RECORDED', 'TRAFFIC_APPLY_STARTED', 'TRAFFIC_APPLIED', 'TRAFFIC_VERIFIED', 'HEALTH_VALIDATION_STARTED', 'HEALTH_VALIDATION_PASSED', 'HEALTH_VALIDATION_FAILED', 'PROMOTION_STARTED', 'ROLLBACK_STARTED', 'ROLLBACK_VERIFIED', 'DEPLOYMENT_SUCCEEDED', 'DEPLOYMENT_FAILED', 'DEPLOYMENT_ROLLED_BACK');

-- CreateTable
CREATE TABLE "public"."applications" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."deployments" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "request_identity" TEXT NOT NULL,
    "target_image" TEXT NOT NULL,
    "stable_image" TEXT,
    "desired_replicas" INTEGER NOT NULL,
    "port" INTEGER NOT NULL,
    "strategy" JSONB NOT NULL,
    "status" "public"."DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "current_stage_index" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "rollback_reason" TEXT,
    "rollback_outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."deployment_stages" (
    "id" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "stage_index" INTEGER NOT NULL,
    "desired_canary_pct" INTEGER NOT NULL,
    "desired_stable_pct" INTEGER NOT NULL,
    "applied_canary_pct" INTEGER,
    "applied_stable_pct" INTEGER,
    "observed_canary_pct" INTEGER,
    "observed_stable_pct" INTEGER,
    "status" "public"."StageStatus" NOT NULL DEFAULT 'UNEVALUATED',
    "operation_id" TEXT,
    "operation_revision" INTEGER,
    "apply_attempt" INTEGER NOT NULL DEFAULT 0,
    "validation_started_at" TIMESTAMP(3),
    "validation_ended_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."health_evaluations" (
    "id" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "stage_id" TEXT NOT NULL,
    "deployment_revision" INTEGER NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3),
    "result" "public"."EvaluationResult" NOT NULL,
    "is_fresh" BOOLEAN NOT NULL DEFAULT true,
    "failure_reason" TEXT,
    "observations" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "health_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."deployment_events" (
    "id" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "event_type" "public"."DeploymentEventType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "applications_name_key" ON "public"."applications"("name");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_request_identity_key" ON "public"."deployments"("request_identity");

-- CreateIndex
CREATE INDEX "idx_deployments_by_app_status" ON "public"."deployments"("application_id", "status");

-- CreateIndex
CREATE INDEX "idx_deployments_by_app" ON "public"."deployments"("application_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_stages_by_deployment" ON "public"."deployment_stages"("deployment_id", "stage_index");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_stages_deployment_id_stage_index_key" ON "public"."deployment_stages"("deployment_id", "stage_index");

-- CreateIndex
CREATE INDEX "idx_health_evals_by_stage" ON "public"."health_evaluations"("deployment_id", "stage_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_health_evals_by_revision" ON "public"."health_evaluations"("deployment_id", "deployment_revision");

-- CreateIndex
CREATE INDEX "idx_events_by_deployment" ON "public"."deployment_events"("deployment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_events_by_type" ON "public"."deployment_events"("event_type", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "public"."deployments" ADD CONSTRAINT "deployments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deployment_stages" ADD CONSTRAINT "deployment_stages_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."health_evaluations" ADD CONSTRAINT "health_evaluations_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."health_evaluations" ADD CONSTRAINT "health_evaluations_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "public"."deployment_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deployment_events" ADD CONSTRAINT "deployment_events_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
