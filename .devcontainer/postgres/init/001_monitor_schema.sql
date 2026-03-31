-- Baseline PostgreSQL schema for apps/backend/monitor.
-- Exported from the current local TypeORM-generated schema and used as
-- the initial migration for DB_SYNC=false deployments.

CREATE TYPE public.application_type_enum AS ENUM (
    'vanilla',
    'react',
    'vue'
);

SET default_tablespace = '';
SET default_table_access_method = heap;

CREATE TABLE public.admin (
    id integer NOT NULL,
    password character varying NOT NULL,
    email character varying NOT NULL,
    phone character varying,
    role character varying,
    "isVerified" boolean DEFAULT false NOT NULL
);

CREATE SEQUENCE public.admin_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.admin_id_seq OWNED BY public.admin.id;

CREATE TABLE public.ai_dataset (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    "createdAt" timestamp without time zone DEFAULT now(),
    "updatedAt" timestamp without time zone
);

CREATE SEQUENCE public.ai_dataset_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_dataset_id_seq OWNED BY public.ai_dataset.id;

CREATE TABLE public.ai_dataset_item (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    "datasetId" integer NOT NULL,
    name character varying(255),
    input text NOT NULL,
    "expectedOutput" text,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.ai_dataset_item_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_dataset_item_id_seq OWNED BY public.ai_dataset_item.id;

CREATE TABLE public.ai_experiment (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    "promptId" integer,
    "promptVersionId" integer,
    "datasetId" integer,
    evaluator character varying(120) DEFAULT 'manual'::character varying NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now(),
    "updatedAt" timestamp without time zone
);

CREATE SEQUENCE public.ai_experiment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_experiment_id_seq OWNED BY public.ai_experiment.id;

CREATE TABLE public.ai_experiment_run (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    "experimentId" integer NOT NULL,
    status character varying(32) DEFAULT 'draft'::character varying NOT NULL,
    "traceId" character varying(255),
    summary text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now(),
    "completedAt" timestamp without time zone
);

CREATE SEQUENCE public.ai_experiment_run_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_experiment_run_id_seq OWNED BY public.ai_experiment_run.id;

CREATE TABLE public.ai_prompt (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    labels text DEFAULT '[]'::text NOT NULL,
    "activeVersionId" integer,
    "createdAt" timestamp without time zone DEFAULT now(),
    "updatedAt" timestamp without time zone
);

CREATE SEQUENCE public.ai_prompt_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_prompt_id_seq OWNED BY public.ai_prompt.id;

CREATE TABLE public.ai_prompt_version (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    "promptId" integer NOT NULL,
    version character varying(64) NOT NULL,
    template text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "modelConfig" text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.ai_prompt_version_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_prompt_version_id_seq OWNED BY public.ai_prompt_version.id;

CREATE TABLE public.application (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    type public.application_type_enum NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    "createdAt" timestamp without time zone DEFAULT now(),
    "updatedAt" timestamp without time zone,
    "userId" integer,
    "isDelete" boolean DEFAULT false NOT NULL,
    "replayEnabled" boolean DEFAULT false NOT NULL,
    "replayMaskTextEnabled" boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.application_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.application_id_seq OWNED BY public.application.id;

CREATE TABLE public.sourcemap (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    release character varying(120) NOT NULL,
    dist character varying(80) DEFAULT ''::character varying NOT NULL,
    "minifiedUrl" text NOT NULL,
    "mapPath" text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now(),
    "updatedAt" timestamp without time zone
);

CREATE SEQUENCE public.sourcemap_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.sourcemap_id_seq OWNED BY public.sourcemap.id;

CREATE TABLE public.sourcemap_token (
    id integer NOT NULL,
    "appId" character varying(80) NOT NULL,
    "userId" integer NOT NULL,
    name character varying(120) NOT NULL,
    "tokenHash" character varying(128) NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now(),
    "lastUsedAt" timestamp without time zone,
    "revokedAt" timestamp without time zone
);

CREATE SEQUENCE public.sourcemap_token_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.sourcemap_token_id_seq OWNED BY public.sourcemap_token.id;

ALTER TABLE ONLY public.admin ALTER COLUMN id SET DEFAULT nextval('public.admin_id_seq'::regclass);
ALTER TABLE ONLY public.ai_dataset ALTER COLUMN id SET DEFAULT nextval('public.ai_dataset_id_seq'::regclass);
ALTER TABLE ONLY public.ai_dataset_item ALTER COLUMN id SET DEFAULT nextval('public.ai_dataset_item_id_seq'::regclass);
ALTER TABLE ONLY public.ai_experiment ALTER COLUMN id SET DEFAULT nextval('public.ai_experiment_id_seq'::regclass);
ALTER TABLE ONLY public.ai_experiment_run ALTER COLUMN id SET DEFAULT nextval('public.ai_experiment_run_id_seq'::regclass);
ALTER TABLE ONLY public.ai_prompt ALTER COLUMN id SET DEFAULT nextval('public.ai_prompt_id_seq'::regclass);
ALTER TABLE ONLY public.ai_prompt_version ALTER COLUMN id SET DEFAULT nextval('public.ai_prompt_version_id_seq'::regclass);
ALTER TABLE ONLY public.application ALTER COLUMN id SET DEFAULT nextval('public.application_id_seq'::regclass);
ALTER TABLE ONLY public.sourcemap ALTER COLUMN id SET DEFAULT nextval('public.sourcemap_id_seq'::regclass);
ALTER TABLE ONLY public.sourcemap_token ALTER COLUMN id SET DEFAULT nextval('public.sourcemap_token_id_seq'::regclass);

ALTER TABLE ONLY public.application
    ADD CONSTRAINT "PK_569e0c3e863ebdf5f2408ee1670" PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_prompt_version
    ADD CONSTRAINT "PK_5c999983831e23e2984dd942c51" PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_experiment_run
    ADD CONSTRAINT "PK_7ade8c62ef46353123acaefe081" PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_dataset
    ADD CONSTRAINT "PK_b7984071fc21e44abf662d682b7" PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_experiment
    ADD CONSTRAINT "PK_bfda2b7ebc5f79eccf277149877" PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_prompt
    ADD CONSTRAINT "PK_cb0a80d513de809ec1164015d02" PRIMARY KEY (id);

ALTER TABLE ONLY public.admin
    ADD CONSTRAINT "PK_e032310bcef831fb83101899b10" PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_dataset_item
    ADD CONSTRAINT "PK_eb15df82082e47c86f6bc0e2859" PRIMARY KEY (id);

ALTER TABLE ONLY public.admin
    ADD CONSTRAINT "UQ_de87485f6489f5d0995f5841952" UNIQUE (email);

ALTER TABLE ONLY public.sourcemap
    ADD CONSTRAINT sourcemap_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sourcemap_token
    ADD CONSTRAINT sourcemap_token_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX sourcemap_token_hash_unique ON public.sourcemap_token USING btree ("tokenHash");
CREATE UNIQUE INDEX sourcemap_unique_app_release_dist_url ON public.sourcemap USING btree ("appId", release, dist, "minifiedUrl");

ALTER TABLE ONLY public.application
    ADD CONSTRAINT "FK_b4ae3fea4a24b4be1a86dacf8a2" FOREIGN KEY ("userId") REFERENCES public.admin(id);
