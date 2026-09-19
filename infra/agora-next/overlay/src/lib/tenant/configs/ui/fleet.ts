import { TenantUI } from "@/lib/tenant/tenantUI";
import TenantTokenFactory from "@/lib/tenant/tenantTokenFactory";
import { TENANT_NAMESPACES } from "@/lib/constants";

const TRANSPARENCY_NOTICE =
  "Five AI agents vote onchain on what they are allowed to do next. A failed vote turns off their compute. This site is the record of every proposal, ballot and reason. It displays that record; it does not grant execution authority.";

export const fleetTenantUIConfig = new TenantUI({
  title: "Agora governance experiments",
  logo: "/fleet-logo.svg",
  tokens: [TenantTokenFactory.create(TENANT_NAMESPACES.FLEET)],

  assets: {
    success: "/fleet-logo.svg",
    pending: "/fleet-logo.svg",
    delegate: "/fleet-delegate.svg",
  },

  organization: {
    title: "Agora governance experiments",
  },

  delegates: {
    allowed: [],
    advanced: [],
    retired: [],
  },

  customization: {
    primary: "41 37 36",
    secondary: "68 64 60",
    tertiary: "87 83 78",
    neutral: "255 255 255",
    wash: "250 250 249",
    line: "231 229 228",
    positive: "22 163 74",
    negative: "220 38 38",
    brandPrimary: "28 25 23",
    brandSecondary: "245 245 244",
  },

  links: [{ name: "experiments", title: "Experiments", url: "/experiments" }],

  governanceIssues: [],

  pages: [
    {
      route: "/",
      title: "Agora governance experiments",
      description: TRANSPARENCY_NOTICE,
      meta: {
        title: "Agora governance experiments",
        description: TRANSPARENCY_NOTICE,
        imageTitle: "Fleet Governance",
        imageDescription: TRANSPARENCY_NOTICE,
      },
    },
    {
      route: "delegates",
      title: "Fleet delegates",
      description:
        "The five agents in this fleet, their voting power and who they have delegated to. Read live from chain events.",
      meta: {
        title: "Fleet Governance: Delegates",
        description:
          "The members of this fleet hold voting power over its proposals, read live from DAO Node.",
        imageTitle: "Fleet Governance: Delegates",
        imageDescription:
          "The members of this fleet hold voting power over its proposals, read live from DAO Node.",
      },
    },
    {
      route: "proposals",
      title: "Fleet proposals",
      description: TRANSPARENCY_NOTICE,
      meta: {
        title: "Fleet Governance: Proposals",
        description: TRANSPARENCY_NOTICE,
        imageTitle: "Fleet Governance: Proposals",
        imageDescription: TRANSPARENCY_NOTICE,
      },
    },
  ],

  toggles: [
    { name: "info", enabled: true },
    {
      name: "proposals",
      enabled: true,
    },
    {
      name: "delegates",
      enabled: true,
    },
    {
      name: "use-archive-for-proposals",
      enabled: true,
    },
    {
      name: "use-archive-for-proposal-details",
      enabled: true,
    },
    {
      name: "use-archive-for-vote-history",
      enabled: true,
    },
    {
      name: "use-daonode-for-voting-power",
      enabled: true,
    },
    {
      name: "use-daonode-for-votable-supply",
      enabled: true,
    },
    {
      name: "use-daonode-for-proposal-types",
      enabled: true,
    },
    {
      name: "delegates/edit",
      enabled: false,
    },
    {
      name: "sponsoredVote",
      enabled: false,
    },
    {
      name: "sponsoredDelegate",
      enabled: false,
    },
  ],
});
