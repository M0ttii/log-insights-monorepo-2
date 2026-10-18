import { describe, expect, it } from "vitest"

import { containerSource, immutableImage } from "./container-config.ts"

const OFFICIAL =
  "serenedb/serenedb:26.10.1@sha256:6d41ac6577e797289158786a2015ba8fbd6875feadb5c491518e166c011058c9"
const ARM_ID =
  "sha256:fd1b13533ceff354ffb48901dd63aa36a4b1d3c2b055b872e572bf83f38a7fb0"

describe("container image identity without a Docker socket", () => {
  it("resolves the verified official manifest to its config digest", () => {
    expect(immutableImage(OFFICIAL)).toEqual({
      reference: OFFICIAL,
      imageId:
        "sha256:01b7f879a34e77409b3cbfb5d25ab08c72646d2a07c69fc498a3bbe29682f6e0",
    })
  })

  it("accepts the verified ARM image by immutable image ID", () => {
    expect(immutableImage(ARM_ID)).toEqual({
      reference: ARM_ID,
      imageId: ARM_ID,
    })
  })

  it.each([
    "",
    "local/serenedb:26.10.1-arm64",
    "serenedb/serenedb:latest",
    `serenedb/serenedb@sha256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(64)}`,
  ])("rejects unverified or mutable references: %s", (reference) => {
    expect(() => immutableImage(reference)).toThrow(/immutable.*SereneDB/)
  })
})

describe("container corpus selection", () => {
  it("defaults to the full base corpus", () => {
    const source = containerSource({ SERENEDB_DATABASE: "postgres" })
    expect(source.id).toBe("corpus")
    expect(source.database).toBeNull()
    expect(source.datasets.map(({ dataset }) => dataset)).toEqual([
      "bgl",
      "openstack",
    ])
  })

  it("loads all Loghub extensions when requested", () => {
    const source = containerSource({ LOG_INSIGHTS_DATASETS: "all" })
    expect(source.datasets.map(({ dataset }) => dataset)).toEqual([
      "bgl",
      "openstack",
      "hdfs",
      "openssh",
      "apache",
      "linux",
      "zookeeper",
    ])
  })

  it("uses the isolated sample database", () => {
    expect(
      containerSource({
        LOG_INSIGHTS_DATA_MODE: "samples",
        SERENEDB_DATABASE: "log_insights_samples",
      }).database
    ).toBe("log_insights_samples")
    expect(
      containerSource({
        LOG_INSIGHTS_DATA_MODE: "samples",
        LOG_INSIGHTS_DATASETS: "all",
        SERENEDB_DATABASE: "log_insights_samples_ext",
      }).database
    ).toBe("log_insights_samples_ext")
  })

  it("rejects a web database that differs from the loader target", () => {
    expect(() =>
      containerSource({ LOG_INSIGHTS_DATA_MODE: "samples" })
    ).toThrow(/SERENEDB_DATABASE=log_insights_samples/)
  })

  it.each([
    { LOG_INSIGHTS_DATA_MODE: "demo" },
    { LOG_INSIGHTS_DATASETS: "typo" },
    { LOG_INSIGHTS_DATASETS: "otel" },
    { LOG_INSIGHTS_DATASETS: "otel_replay" },
  ])("rejects unsupported container selections: %j", (env) => {
    expect(() => containerSource(env)).toThrow(
      /LOG_INSIGHTS_DATA_MODE|Unknown dataset|Loghub extensions only/
    )
  })
})
