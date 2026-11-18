package Koha::Plugin::MarcHelper::Stage;

# Koha MARC Helper - a Koha plugin for copy cataloguing
# Copyright (C) 2026 Amalendu Das
#
# This program is free software: you can redistribute it and/or modify it under the
# terms of the GNU General Public License as published by the Free Software Foundation,
# either version 3 of the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY
# WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
# PARTICULAR PURPOSE. See the GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along with this
# program. If not, see <https://www.gnu.org/licenses/>.

# Batch cataloguing: the reviewed records go into Koha's own staging area, as Tools ›
# Stage MARC records for import does (C4::ImportBatch), and are checked against the
# catalogue with the chosen matching rule. Nothing is added to the catalogue here: the
# cataloguer imports the batch in Tools › Manage staged MARC records.

use Modern::Perl;
use File::Temp qw(tempfile);
use Encode qw(encode);
use C4::ImportBatch;
use C4::Matcher;

our $MAX_RECORDS = 500;

# {marcxml, name, matcher_id} -> {batch_id, staged, invalid, matches, matcher, link} or {error}
sub stage {
    my ($args) = @_;
    my $xml = $args->{marcxml} // '';
    return { error => 'No records were sent' } unless $xml =~ /<(?:\w+:)?record\b/;
    my $count = () = $xml =~ /<(?:\w+:)?record\b/g;
    return { error => "At most $MAX_RECORDS records can be staged at a time" } if $count > $MAX_RECORDS;

    # Koha's own MARCXML reader, as for an uploaded file
    my ( $fh, $path ) = tempfile( 'marchelper-XXXXXX', SUFFIX => '.xml', TMPDIR => 1, UNLINK => 1 );
    binmode $fh;
    print {$fh} encode( 'UTF-8', $xml );
    close $fh;
    my ( $errors, $records ) = C4::ImportBatch::RecordsFromMARCXMLFile( $path, 'UTF-8' );
    unlink $path;
    return { error => 'The records could not be read: ' . join( '; ', @{ $errors // [] } ) } unless $records && @$records;

    my $name = $args->{name} // '';
    $name =~ s/[^\w .,()-]+//g;
    $name = substr( $name, 0, 80 );
    $name = 'marchelper-batch.xml' if $name eq '';
    my ( $batch_id, $num_valid, $num_items, @invalid ) = C4::ImportBatch::BatchStageMarcRecords(
        'biblio', 'UTF-8', $records, $name, undef,
        'Koha MARC Helper batch cataloguing', '', 0, 0
    );

    # Records already in the catalogue: matched and left alone (not overlaid); new ones added
    my ( $matches, $matcher_code ) = ( 0, '' );
    if ( my $matcher_id = $args->{matcher_id} ) {
        my $matcher = C4::Matcher->fetch($matcher_id);
        if ($matcher) {
            $matches      = C4::ImportBatch::BatchFindDuplicates( $batch_id, $matcher, 10 ) // 0;
            $matcher_code = $matcher->code;
            C4::ImportBatch::SetImportBatchMatcher( $batch_id, $matcher_id );
            C4::ImportBatch::SetImportBatchOverlayAction( $batch_id, 'ignore' );
            C4::ImportBatch::SetImportBatchNoMatchAction( $batch_id, 'create_new' );
            C4::ImportBatch::SetImportBatchItemAction( $batch_id, 'ignore' );
        }
    }
    return {
        batch_id => $batch_id + 0,
        staged   => $num_valid + 0,
        invalid  => scalar(@invalid) + 0,
        matches  => $matches + 0,
        matcher  => $matcher_code,
        link     => "/cgi-bin/koha/tools/manage-marc-import.pl?import_batch_id=$batch_id",
    };
}

1;
