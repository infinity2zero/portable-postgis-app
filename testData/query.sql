CREATE TABLE "public"."Artist" ( 
  "ArtistId" INTEGER NOT NULL,
  "Name" VARCHAR(120) NULL,
  CONSTRAINT "PK_Artist" PRIMARY KEY ("ArtistId")
);

CREATE TABLE "public"."Album" ( 
  "AlbumId" INTEGER NOT NULL,
  "Title" VARCHAR(160) NOT NULL,
  "ArtistId" INTEGER NOT NULL,
  CONSTRAINT "PK_Album" PRIMARY KEY ("AlbumId"),
  CONSTRAINT "FK_AlbumArtistId" FOREIGN KEY ("ArtistId") REFERENCES "public"."Artist" ("ArtistId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "IFK_AlbumArtistId" 
ON "public"."Album" (
  "ArtistId" ASC
);
CREATE TABLE "public"."Employee" ( 
  "EmployeeId" INTEGER NOT NULL,
  "LastName" VARCHAR(20) NOT NULL,
  "FirstName" VARCHAR(20) NOT NULL,
  "Title" VARCHAR(30) NULL,
  "ReportsTo" INTEGER NULL,
  "BirthDate" TIMESTAMP NULL,
  "HireDate" TIMESTAMP NULL,
  "Address" VARCHAR(70) NULL,
  "City" VARCHAR(40) NULL,
  "State" VARCHAR(40) NULL,
  "Country" VARCHAR(40) NULL,
  "PostalCode" VARCHAR(10) NULL,
  "Phone" VARCHAR(24) NULL,
  "Fax" VARCHAR(24) NULL,
  "Email" VARCHAR(60) NULL,
  CONSTRAINT "PK_Employee" PRIMARY KEY ("EmployeeId"),
  CONSTRAINT "FK_EmployeeReportsTo" FOREIGN KEY ("ReportsTo") REFERENCES "public"."Employee" ("EmployeeId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "IFK_EmployeeReportsTo" 
ON "public"."Employee" (
  "ReportsTo" ASC
);


CREATE TABLE "public"."Customer" ( 
  "CustomerId" INTEGER NOT NULL,
  "FirstName" VARCHAR(40) NOT NULL,
  "LastName" VARCHAR(20) NOT NULL,
  "Company" VARCHAR(80) NULL,
  "Address" VARCHAR(70) NULL,
  "City" VARCHAR(40) NULL,
  "State" VARCHAR(40) NULL,
  "Country" VARCHAR(40) NULL,
  "PostalCode" VARCHAR(10) NULL,
  "Phone" VARCHAR(24) NULL,
  "Fax" VARCHAR(24) NULL,
  "Email" VARCHAR(60) NOT NULL,
  "SupportRepId" INTEGER NULL,
  CONSTRAINT "PK_Customer" PRIMARY KEY ("CustomerId"),
  CONSTRAINT "FK_CustomerSupportRepId" FOREIGN KEY ("SupportRepId") REFERENCES "public"."Employee" ("EmployeeId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "IFK_CustomerSupportRepId" 
ON "public"."Customer" (
  "SupportRepId" ASC
);


CREATE TABLE "public"."Genre" ( 
  "GenreId" INTEGER NOT NULL,
  "Name" VARCHAR(120) NULL,
  CONSTRAINT "PK_Genre" PRIMARY KEY ("GenreId")
);

CREATE TABLE "public"."Invoice" ( 
  "InvoiceId" INTEGER NOT NULL,
  "CustomerId" INTEGER NOT NULL,
  "InvoiceDate" TIMESTAMP NOT NULL,
  "BillingAddress" VARCHAR(70) NULL,
  "BillingCity" VARCHAR(40) NULL,
  "BillingState" VARCHAR(40) NULL,
  "BillingCountry" VARCHAR(40) NULL,
  "BillingPostalCode" VARCHAR(10) NULL,
  "Total" NUMERIC NOT NULL,
  CONSTRAINT "PK_Invoice" PRIMARY KEY ("InvoiceId"),
  CONSTRAINT "FK_InvoiceCustomerId" FOREIGN KEY ("CustomerId") REFERENCES "public"."Customer" ("CustomerId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "IFK_InvoiceCustomerId" 
ON "public"."Invoice" (
  "CustomerId" ASC
);

CREATE TABLE "public"."MediaType" ( 
  "MediaTypeId" INTEGER NOT NULL,
  "Name" VARCHAR(120) NULL,
  CONSTRAINT "PK_MediaType" PRIMARY KEY ("MediaTypeId")
);


CREATE TABLE "public"."Track" ( 
  "TrackId" INTEGER NOT NULL,
  "Name" VARCHAR(200) NOT NULL,
  "AlbumId" INTEGER NULL,
  "MediaTypeId" INTEGER NOT NULL,
  "GenreId" INTEGER NULL,
  "Composer" VARCHAR(220) NULL,
  "Milliseconds" INTEGER NOT NULL,
  "Bytes" INTEGER NULL,
  "UnitPrice" NUMERIC NOT NULL,
  CONSTRAINT "PK_Track" PRIMARY KEY ("TrackId"),
  CONSTRAINT "FK_TrackAlbumId" FOREIGN KEY ("AlbumId") REFERENCES "public"."Album" ("AlbumId") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "FK_TrackGenreId" FOREIGN KEY ("GenreId") REFERENCES "public"."Genre" ("GenreId") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "FK_TrackMediaTypeId" FOREIGN KEY ("MediaTypeId") REFERENCES "public"."MediaType" ("MediaTypeId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "IFK_TrackAlbumId" 
ON "public"."Track" (
  "AlbumId" ASC
);
CREATE INDEX "IFK_TrackGenreId" 
ON "public"."Track" (
  "GenreId" ASC
);
CREATE INDEX "IFK_TrackMediaTypeId" 
ON "public"."Track" (
  "MediaTypeId" ASC
);

CREATE TABLE "public"."InvoiceLine" ( 
  "InvoiceLineId" INTEGER NOT NULL,
  "InvoiceId" INTEGER NOT NULL,
  "TrackId" INTEGER NOT NULL,
  "UnitPrice" NUMERIC NOT NULL,
  "Quantity" INTEGER NOT NULL,
  CONSTRAINT "PK_InvoiceLine" PRIMARY KEY ("InvoiceLineId"),
  CONSTRAINT "FK_InvoiceLineInvoiceId" FOREIGN KEY ("InvoiceId") REFERENCES "public"."Invoice" ("InvoiceId") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "FK_InvoiceLineTrackId" FOREIGN KEY ("TrackId") REFERENCES "public"."Track" ("TrackId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "IFK_InvoiceLineInvoiceId" 
ON "public"."InvoiceLine" (
  "InvoiceId" ASC
);
CREATE INDEX "IFK_InvoiceLineTrackId" 
ON "public"."InvoiceLine" (
  "TrackId" ASC
);

CREATE TABLE "public"."Playlist" ( 
  "PlaylistId" INTEGER NOT NULL,
  "Name" VARCHAR(120) NULL,
  CONSTRAINT "PK_Playlist" PRIMARY KEY ("PlaylistId")
);


CREATE TABLE "public"."PlaylistTrack" ( 
  "PlaylistId" INTEGER NOT NULL,
  "TrackId" INTEGER NOT NULL,
  CONSTRAINT "PK_PlaylistTrack" PRIMARY KEY ("PlaylistId", "TrackId"),
  CONSTRAINT "FK_PlaylistTrackPlaylistId" FOREIGN KEY ("PlaylistId") REFERENCES "public"."Playlist" ("PlaylistId") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "FK_PlaylistTrackTrackId" FOREIGN KEY ("TrackId") REFERENCES "public"."Track" ("TrackId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "IFK_PlaylistTrackTrackId" 
ON "public"."PlaylistTrack" (
  "TrackId" ASC
);









