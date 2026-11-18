#!/usr/bin/perl
# Koha MARC Helper - batch cataloguing: records staged in Koha's staging area.
# Needs a Koha (run inside it: koha-shell <instance> -c 'prove -I<plugins dir> t/stage.t');
# skipped elsewhere. The test batch is deleted again at the end.
use Modern::Perl;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/..";

BEGIN {
    eval { require C4::Context; require C4::ImportBatch; C4::Context->dbh; 1 }
        or plan skip_all => 'Not inside a Koha (C4::Context not available)';
}
use Koha::Plugin::MarcHelper::Stage;

my $xml = <<'XML';
<?xml version="1.0" encoding="UTF-8"?>
<collection xmlns="http://www.loc.gov/MARC21/slim">
  <record>
    <leader>     nam a22     7c 4500</leader>
    <datafield tag="020" ind1=" " ind2=" "><subfield code="a">9780000000002</subfield></datafield>
    <datafield tag="245" ind1="0" ind2="0"><subfield code="a">Test record for Koha MARC Helper staging</subfield></datafield>
  </record>
  <record>
    <leader>     nas a22     7c 4500</leader>
    <datafield tag="022" ind1=" " ind2=" "><subfield code="a">0028-0836</subfield></datafield>
    <datafield tag="245" ind1="0" ind2="0"><subfield code="a">Gītāñjali test serial</subfield></datafield>
  </record>
</collection>
XML

my ($isbn_rule) = grep { $_->{code} eq 'ISBN' } C4::Matcher::GetMatcherList();
my $out = Koha::Plugin::MarcHelper::Stage::stage( { marcxml => $xml, name => 'marchelper <test>.xml', matcher_id => $isbn_rule ? $isbn_rule->{matcher_id} : undef } );
ok( $out->{batch_id}, 'a batch is staged' ) or diag explain $out;
is( $out->{staged}, 2, 'both records staged (book and serial)' );
like( $out->{link}, qr{manage-marc-import\.pl\?import_batch_id=\d+$}, 'link to Manage staged MARC records' );

my $batch = C4::ImportBatch::GetImportBatch( $out->{batch_id} );
is( $batch->{import_status}, 'staged', 'status staged (nothing imported into the catalogue)' );
is( $batch->{file_name}, 'marchelper test.xml', 'batch name cleaned' );
SKIP: {
    skip 'no ISBN matching rule in this Koha', 2 unless $isbn_rule;
    is( $batch->{matcher_id}, $isbn_rule->{matcher_id}, 'the matching rule is set on the batch' );
    is( $batch->{overlay_action}, 'ignore', 'records already in the catalogue are not overlaid' );
}
my $records = C4::ImportBatch::GetImportRecordsRange( $out->{batch_id} );
my ($serial) = grep { ( $_->{title} // '' ) =~ /test serial/ } @$records;
ok( $serial, 'the serial is in the batch, its title in UTF-8 intact' ) and like( $serial->{title}, qr/Gītāñjali/, '... diacritics kept' );

like( Koha::Plugin::MarcHelper::Stage::stage( { marcxml => '<collection/>' } )->{error}, qr/No records/, 'nothing to stage: refused' );
{
    local $Koha::Plugin::MarcHelper::Stage::MAX_RECORDS = 1;
    like( Koha::Plugin::MarcHelper::Stage::stage( { marcxml => $xml } )->{error}, qr/At most 1/, 'too many records: refused' );
}

# Clean up: the test batch goes again
C4::ImportBatch::CleanBatch( $out->{batch_id} );
C4::ImportBatch::DeleteBatch( $out->{batch_id} );
ok( !C4::ImportBatch::GetImportBatch( $out->{batch_id} ), 'test batch deleted again' );

done_testing;
